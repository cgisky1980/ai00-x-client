//! dsh sidecar 反向代理：把 webview（origin = 内嵌服务器 2100）的同源请求
//! 转发到 dsh 引擎（127.0.0.1:3210）。
//!
//! 为什么必须代理：dsh 的 /api 信任栅栏要求 Origin 与请求 Host 完全同源
//! （isTrustedApiRequest），webview 页面在 2100、引擎在 3210，直连跨源必被
//! 403。经本代理转发时由 reqwest/tokio-tungstenite 发起（无 Origin 头）
//! → 栅栏放行。
//!
//! 路由：
//! - `POST /dsh-api/{*path}` → `http://127.0.0.1:3210/api/{path}`（unary RPC）
//! - `GET  /dsh-ws/events.mux` → `ws://127.0.0.1:3210/api/events.mux`（WS 双向泵）

use futures::{SinkExt, StreamExt};
use salvo::http::StatusCode;
use salvo::prelude::*;
use salvo::websocket::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as UpMessage;

use crate::dsh_manager;

const DSH_HTTP_ORIGIN: &str = "http://127.0.0.1:3210";
const DSH_WS_UPSTREAM: &str = "ws://127.0.0.1:3210/api/events.mux";

/// 挂到主 router 的代理子路由。
pub fn router() -> Router {
    Router::new()
        .push(
            Router::with_path("dsh-api/{*path}")
                .hoop(no_cache)
                .post(proxy_rpc),
        )
        .push(
            Router::with_path("dsh-ws/events.mux")
                .hoop(no_cache)
                .get(proxy_ws),
        )
}

#[handler]
async fn no_cache(res: &mut Response) {
    res.headers_mut().insert(
        salvo::http::header::CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

/// unary RPC 透传：body 原样转发，响应原样返回（剥 Origin → 栅栏放行）。
#[handler]
async fn proxy_rpc(req: &mut Request, res: &mut Response) {
    let Some(path) = req.param::<String>("path") else {
        res.status_code(StatusCode::NOT_FOUND);
        return;
    };
    let url = format!("{DSH_HTTP_ORIGIN}/api/{path}");

    let body: Vec<u8> = match req.payload().await {
        Ok(bytes) => bytes.to_vec(),
        Err(e) => {
            res.status_code(StatusCode::BAD_REQUEST);
            res.render(Text::Plain(format!("read body failed: {e}")));
            return;
        }
    };

    let client = reqwest::Client::new();
    let upstream = match client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // 引擎未就绪等场景：502 + 错误 JSON，前端提示重试
            res.status_code(StatusCode::BAD_GATEWAY);
            res.render(Text::Json(
                json!({"error": {"message": format!("dsh engine unreachable: {e}")}}).to_string(),
            ));
            return;
        }
    };

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = upstream.bytes().await.unwrap_or_default();

    res.status_code(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    if let Ok(ct) = salvo::http::HeaderValue::from_str(&content_type) {
        res.headers_mut()
            .insert(salvo::http::header::CONTENT_TYPE, ct);
    }
    res.body(bytes);
}

/// WebSocket 双向泵：webview WS ↔ 引擎 events.mux。
#[handler]
async fn proxy_ws(req: &mut Request, res: &mut Response) -> Result<(), StatusError> {
    // 引擎在线才接受升级（否则前端 WS 立即断开走重连逻辑）
    if !dsh_manager::engine_running() {
        res.status_code(StatusCode::SERVICE_UNAVAILABLE);
        res.render(Text::Json(
            json!({"error": {"message": "dsh engine not running"}}).to_string(),
        ));
        return Ok(());
    }

    WebSocketUpgrade::new()
        .upgrade(req, res, |ws| async move {
            pump_websocket(ws).await;
        })
        .await
}

/// 把一侧 WS 与引擎 events.mux 互连（全双工转发，任一侧断开即结束）。
async fn pump_websocket(client_ws: WebSocket) {
    let (upstream, _) = match tokio_tungstenite::connect_async(DSH_WS_UPSTREAM).await {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("[dsh-proxy] upstream ws connect failed: {e}");
            return;
        }
    };

    let (mut client_sink, mut client_stream) = client_ws.split();
    let (mut upstream_sink, mut upstream_stream) = upstream.split();

    // 客户端 → 引擎（协议上 mux 无上行，但保持透传以防协议演进）
    let c2u = async move {
        while let Some(Ok(msg)) = client_stream.next().await {
            let forwarded = if msg.is_text() {
                UpMessage::Text(msg.as_str().unwrap_or_default().to_owned())
            } else if msg.is_binary() {
                UpMessage::Binary(msg.as_bytes().to_owned())
            } else if msg.is_ping() {
                UpMessage::Ping(msg.as_bytes().to_owned())
            } else if msg.is_pong() {
                UpMessage::Pong(msg.as_bytes().to_owned())
            } else {
                // Close 或未知帧：结束
                break;
            };
            if upstream_sink.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = upstream_sink.close().await;
    };

    // 引擎 → 客户端（事件流主体方向）
    let u2c = async move {
        while let Some(Ok(msg)) = upstream_stream.next().await {
            let forwarded = match msg {
                UpMessage::Text(text) => WsMessage::text(text),
                UpMessage::Binary(bin) => WsMessage::binary(bin),
                UpMessage::Ping(p) => WsMessage::ping(p),
                UpMessage::Pong(p) => WsMessage::pong(p),
                UpMessage::Close(_) => break,
                UpMessage::Frame(_) => continue,
            };
            if client_sink.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = client_sink.close().await;
    };

    tokio::join!(c2u, u2c);
}

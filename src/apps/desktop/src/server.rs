use salvo::compression::Compression;
use salvo::http::header::CACHE_CONTROL;
use salvo::http::HeaderValue;
use salvo::prelude::*;
use salvo::serve_static::StaticDir;
use std::net::SocketAddr;
use std::thread;

use crate::zip_serve::{serve_main_app, serve_underlay};
use ai00_x_core::service::config::server_endpoints::{LOCAL_EMBEDDED_SERVER_PORT, LOCAL_HOST};

const SERVER_HOST: &str = LOCAL_HOST;
const SERVER_PORT: u16 = LOCAL_EMBEDDED_SERVER_PORT;

/// Get the wallpaper data directory (absolute path).
fn wallpaper_dir() -> String {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Ai00-X")
        .join("wallpapers")
        .to_string_lossy()
        .to_string()
}

/// Get the workspace wallpaper projects directory (under exe dir).
fn workspace_wallpaper_projects_dir() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent()
                .map(|d| d.join("workspaces").join("wallpaper").join("projects"))
        })
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

fn router() -> Router {
    Router::new()
        .hoop(Compression::new())
        .hoop(cors_allow_all)
        .push(
            Router::with_path("underlay/assets/{*path}")
                .hoop(cache_headers)
                .get(
                    StaticDir::new([
                        "../../../dist/underlay/assets",
                        "../../dist/underlay/assets",
                        "../dist/underlay/assets",
                        "dist/underlay/assets",
                    ])
                    .auto_list(false),
                ),
        )
        .push(
            Router::with_path("underlay/{*path}")
                .hoop(no_cache)
                .get(serve_underlay),
        )
        .push(
            Router::with_path("main/assets/{*path}")
                .hoop(cache_headers)
                .get(
                    StaticDir::new([
                        "../../../dist/main/assets",
                        "../../dist/main/assets",
                        "../dist/main/assets",
                        "dist/main/assets",
                    ])
                    .auto_list(false),
                ),
        )
        .push(
            Router::with_path("main/{*path}")
                .hoop(no_cache)
                .get(serve_main_app),
        )
        .push(
            Router::with_path("shared/{*path}").hoop(cache_headers).get(
                StaticDir::new([
                    "../../../dist/shared",
                    "../../dist/shared",
                    "../dist/shared",
                    "../public/shared",
                    "dist/shared",
                    "public/shared",
                ])
                .auto_list(false),
            ),
        )
        .push(
            Router::with_path("assets/{*path}").hoop(cache_headers).get(
                StaticDir::new([
                    "../../../dist/loader/assets",
                    "../../dist/loader/assets",
                    "../dist/loader/assets",
                    "dist/loader/assets",
                ])
                .auto_list(false),
            ),
        )
        .push(
            Router::with_path("wallpapers/{*path}")
                .hoop(no_cache)
                .get(StaticDir::new([wallpaper_dir()]).auto_list(false)),
        )
        // URL: http://127.0.0.1:2100/wallpaper/projects/<uuid>/index.html
        .push(
            Router::with_path("wallpaper/projects/{*path}")
                .hoop(no_cache)
                .get(StaticDir::new([workspace_wallpaper_projects_dir()]).auto_list(false)),
        )
        .push(
            Router::with_path("{*path}").hoop(no_cache).get(
                StaticDir::new([
                    "../../../dist/loader",
                    "../../dist/loader",
                    "../dist/loader",
                    "dist/loader",
                ])
                .defaults("index.html")
                .auto_list(false),
            ),
        )
}

/// CORS 中间件：允许所有 origin 访问本地内嵌服务器(2100)。
///
/// 本地服务器只绑定 127.0.0.1，无外部暴露风险，故放行所有 origin。
/// Tauri webview 的 origin 是 tauri.localhost，访问 127.0.0.1:2100 需要 CORS 头。
#[handler]
async fn cors_allow_all(req: &mut Request, res: &mut Response) {
    res.headers_mut().insert(
        salvo::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    res.headers_mut().insert(
        salvo::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, OPTIONS"),
    );
    res.headers_mut().insert(
        salvo::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    // OPTIONS 预检直接返回 204
    if req.method() == salvo::http::Method::OPTIONS {
        res.status_code(StatusCode::NO_CONTENT);
    }
}

#[handler]
async fn cache_headers(res: &mut Response) {
    res.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
}

#[handler]
async fn no_cache(res: &mut Response) {
    res.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

pub fn start_salvo_server() {
    thread::spawn(|| match tokio::runtime::Runtime::new() {
        Ok(rt) => {
            rt.block_on(async move {
                let addr: SocketAddr = format!("{}:{}", SERVER_HOST, SERVER_PORT).parse().unwrap();
                let listener = TcpListener::new(addr);
                match listener.try_bind().await {
                    Ok(acceptor) => {
                        let r = router();
                        log::info!("[salvo] serving at http://{}", addr);
                        Server::new(acceptor).serve(r).await;
                    }
                    Err(e) => {
                        log::error!("[salvo] FAILED TO BIND port {}: {}", SERVER_PORT, e);
                    }
                }
            });
        }
        Err(e) => {
            log::error!("[salvo] FAILED TO CREATE TOKIO RUNTIME: {}", e);
        }
    });
}

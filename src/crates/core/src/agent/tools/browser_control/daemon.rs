use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::util::errors::{Ai00XError, Ai00XResult};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

pub const DEFAULT_DAEMON_PORT: u16 = 19926;

type PendingMap = HashMap<String, oneshot::Sender<DaemonResult>>;

#[derive(Debug, Serialize, Deserialize)]
pub struct DaemonCommand {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    30000
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DaemonResult {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DaemonResult {
    pub fn success(id: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            id: id.into(),
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(id: impl Into<String>, error: String) -> Self {
        Self {
            id: id.into(),
            ok: false,
            data: None,
            error: Some(error),
        }
    }
}

pub struct DaemonState {
    pub extension_tx: Mutex<Option<futures::stream::SplitSink<WebSocket, Message>>>,
    pub pending_commands: RwLock<PendingMap>,
    pub extension_connected: RwLock<bool>,
    pub last_activity: RwLock<Instant>,
}

impl DaemonState {
    fn new() -> Self {
        Self {
            extension_tx: Mutex::new(None),
            pending_commands: RwLock::new(HashMap::new()),
            extension_connected: RwLock::new(false),
            last_activity: RwLock::new(Instant::now()),
        }
    }

    pub async fn is_extension_connected(&self) -> bool {
        *self.extension_connected.read().await
    }

    async fn touch(&self) {
        *self.last_activity.write().await = Instant::now();
    }
}

pub struct BrowserDaemon {
    port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    state: Arc<DaemonState>,
}

impl BrowserDaemon {
    pub async fn start(port: u16) -> Ai00XResult<Self> {
        let state = Arc::new(DaemonState::new());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let cors = tower_http::cors::CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any);

        let app = Router::new()
            .route("/health", get(health_handler))
            .route("/ping", get(health_handler))
            .route("/status", get(status_handler))
            .route("/command", post(command_handler))
            .route("/ext", get(ws_handler))
            .layer(cors)
            .with_state(state.clone());

        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
            .await
            .map_err(|e| Ai00XError::Service(format!("Failed to bind daemon port {port}: {e}")))?;

        info!("Browser daemon listening on port {}", port);

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                    info!("Browser daemon received shutdown signal");
                })
                .await
                .ok();
        });

        Ok(Self {
            port,
            shutdown_tx: Some(shutdown_tx),
            state,
        })
    }

    pub async fn shutdown(mut self) -> Ai00XResult<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        info!("Browser daemon shutdown complete on port {}", self.port);
        Ok(())
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn state(&self) -> Arc<DaemonState> {
        self.state.clone()
    }
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn status_handler(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    let ext = *state.extension_connected.read().await;
    let pending = state.pending_commands.read().await.len();
    Json(json!({
        "daemon": true,
        "extension": ext,
        "extensionConnected": ext,
        "pending": pending,
    }))
}

async fn command_handler(
    State(state): State<Arc<DaemonState>>,
    Json(cmd): Json<DaemonCommand>,
) -> impl IntoResponse {
    state.touch().await;

    if !*state.extension_connected.read().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Extension not connected" })),
        );
    }

    let cmd_id = cmd.id.clone();

    let (tx, rx) = oneshot::channel::<DaemonResult>();
    state
        .pending_commands
        .write()
        .await
        .insert(cmd_id.clone(), tx);

    {
        let mut ext_tx = state.extension_tx.lock().await;
        if let Some(ref mut sink) = *ext_tx {
            let msg = serde_json::to_string(&cmd).unwrap_or_default();
            if let Err(e) = sink.send(Message::Text(msg)).await {
                state.pending_commands.write().await.remove(&cmd_id);
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("Failed to send to extension: {e}") })),
                );
            }
        } else {
            state.pending_commands.write().await.remove(&cmd_id);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "Extension WebSocket not available" })),
            );
        }
    }

    let timeout = Duration::from_millis(cmd.timeout_ms.max(1000));
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => {
            let status = if result.ok {
                StatusCode::OK
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            };
            (
                status,
                Json(serde_json::to_value(result).unwrap_or(json!({}))),
            )
        }
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Command channel closed unexpectedly" })),
        ),
        Err(_) => {
            state.pending_commands.write().await.remove(&cmd_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "error": "Command timed out" })),
            )
        }
    }
}

async fn ws_handler(
    State(state): State<Arc<DaemonState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_extension_ws(state, socket))
}

async fn handle_extension_ws(state: Arc<DaemonState>, socket: WebSocket) {
    let (sender, mut receiver) = socket.split();

    *state.extension_tx.lock().await = Some(sender);
    *state.extension_connected.write().await = true;
    info!("Browser extension connected");

    let heartbeat_state = state.clone();
    let heartbeat_handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(HEARTBEAT_INTERVAL).await;
            let mut tx = heartbeat_state.extension_tx.lock().await;
            if let Some(ref mut sink) = *tx {
                if sink.send(Message::Ping(vec![])).await.is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });

    while let Some(msg) = receiver.next().await {
        state.touch().await;
        match msg {
            Ok(Message::Text(text)) => {
                debug!("Received message from extension, len={}", text.len());

                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text.as_str()) {
                    let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if msg_type == "log" || msg_type == "hello" {
                        continue;
                    }
                }

                match serde_json::from_str::<DaemonResult>(&text) {
                    Ok(result) => {
                        let id = result.id.clone();
                        if let Some(tx) = state.pending_commands.write().await.remove(&id) {
                            let _ = tx.send(result);
                        } else {
                            warn!("Received result for unknown command id={}", id);
                        }
                    }
                    Err(e) => {
                        warn!("Failed to parse extension message: {}", e);
                    }
                }
            }
            Ok(Message::Pong(_)) => {
                debug!("Pong from extension");
            }
            Ok(Message::Close(_)) => {
                info!("Extension sent close frame");
                break;
            }
            Err(e) => {
                error!("Extension ws error: {}", e);
                break;
            }
            _ => {}
        }
    }

    heartbeat_handle.abort();
    *state.extension_tx.lock().await = None;
    *state.extension_connected.write().await = false;
    info!("Browser extension disconnected");

    let mut pending = state.pending_commands.write().await;
    for (id, tx) in pending.drain() {
        let _ = tx.send(DaemonResult::failure(
            id,
            "Extension disconnected".to_string(),
        ));
    }
}

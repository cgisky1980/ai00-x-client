use ai00_x_core::agent::tools::browser_control::browser_launcher::{
    BrowserKind, BrowserLauncher, LaunchResult, DEFAULT_CDP_PORT,
};
use ai00_x_core::agent::tools::browser_control::cdp_client::CdpClient;
use ai00_x_core::agent::tools::browser_control::daemon::DEFAULT_DAEMON_PORT;
use ai00_x_core::agent::tools::browser_control::daemon_client::DaemonClient;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlStatusRequest {
    #[serde(default = "default_cdp_port")]
    pub port: u16,
}

fn default_cdp_port() -> u16 {
    DEFAULT_CDP_PORT
}

fn default_daemon_port() -> u16 {
    DEFAULT_DAEMON_PORT
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlStatusResponse {
    pub cdp_available: bool,
    pub browser_kind: String,
    pub browser_version: Option<String>,
    pub port: u16,
    pub page_count: usize,
    pub daemon_running: bool,
    pub extension_connected: bool,
    pub daemon_port: u16,
    pub recommended_mode: String,
}

#[tauri::command]
pub async fn browser_control_get_status(
    request: BrowserControlStatusRequest,
) -> Result<BrowserControlStatusResponse, String> {
    let port = request.port;
    let cdp_available = BrowserLauncher::is_cdp_available(port).await;
    let kind = BrowserLauncher::detect_default_browser().unwrap_or(BrowserKind::Chrome);

    let (version, page_count) = if cdp_available {
        let ver = CdpClient::get_version(port)
            .await
            .ok()
            .and_then(|v| v.browser);
        let pages = CdpClient::list_pages(port)
            .await
            .ok()
            .map(|p| p.len())
            .unwrap_or(0);
        (ver, pages)
    } else {
        (None, 0)
    };

    let daemon_client = DaemonClient::default_client();
    let daemon_running = daemon_client.is_running().await;
    let extension_connected = if daemon_running {
        daemon_client.is_extension_connected().await
    } else {
        false
    };

    let recommended_mode = if daemon_running && extension_connected {
        "extension".to_string()
    } else if cdp_available {
        "cdp".to_string()
    } else {
        "none".to_string()
    };

    Ok(BrowserControlStatusResponse {
        cdp_available,
        browser_kind: kind.to_string(),
        browser_version: version,
        port,
        page_count,
        daemon_running,
        extension_connected,
        daemon_port: DEFAULT_DAEMON_PORT,
        recommended_mode,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlLaunchRequest {
    #[serde(default = "default_cdp_port")]
    pub port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlLaunchResponse {
    pub success: bool,
    pub status: String,
    pub message: Option<String>,
    pub browser_kind: String,
}

#[tauri::command]
pub async fn browser_control_launch(
    request: BrowserControlLaunchRequest,
) -> Result<BrowserControlLaunchResponse, String> {
    let port = request.port;
    let kind = BrowserLauncher::detect_default_browser().map_err(|e| e.to_string())?;

    let result = BrowserLauncher::launch_with_cdp(&kind, port)
        .await
        .map_err(|e| e.to_string())?;

    match result {
        LaunchResult::AlreadyConnected => Ok(BrowserControlLaunchResponse {
            success: true,
            status: "already_connected".into(),
            message: None,
            browser_kind: kind.to_string(),
        }),
        LaunchResult::Launched => Ok(BrowserControlLaunchResponse {
            success: true,
            status: "launched".into(),
            message: None,
            browser_kind: kind.to_string(),
        }),
        LaunchResult::LaunchedButCdpNotReady { message, .. } => Ok(BrowserControlLaunchResponse {
            success: false,
            status: "cdp_not_ready".into(),
            message: Some(message),
            browser_kind: kind.to_string(),
        }),
        LaunchResult::BrowserRunningWithoutCdp { instructions, .. } => {
            Ok(BrowserControlLaunchResponse {
                success: false,
                status: "needs_restart".into(),
                message: Some(instructions),
                browser_kind: kind.to_string(),
            })
        }
    }
}

#[tauri::command]
pub async fn browser_control_create_launcher() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let kind = BrowserLauncher::detect_default_browser().map_err(|e| e.to_string())?;
        BrowserLauncher::create_cdp_launcher_app(&kind, DEFAULT_CDP_PORT).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("CDP launcher app creation is only supported on macOS".into())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusRequest {
    #[serde(default = "default_daemon_port")]
    pub daemon_port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusResponse {
    pub daemon_running: bool,
    pub extension_connected: bool,
    pub daemon_port: u16,
}

#[tauri::command]
pub async fn browser_control_daemon_status(
    request: DaemonStatusRequest,
) -> Result<DaemonStatusResponse, String> {
    let client = DaemonClient::new(request.daemon_port);
    let running = client.is_running().await;
    let ext_connected = if running {
        client.is_extension_connected().await
    } else {
        false
    };

    Ok(DaemonStatusResponse {
        daemon_running: running,
        extension_connected: ext_connected,
        daemon_port: request.daemon_port,
    })
}

use reqwest::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::util::errors::{Ai00XError, Ai00XResult};

use super::daemon::{DaemonCommand, DaemonResult, DEFAULT_DAEMON_PORT};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct DaemonClient {
    base_url: String,
    client: Client,
}

impl DaemonClient {
    pub fn new(port: u16) -> Self {
        let base_url = format!("http://127.0.0.1:{port}");
        let client = Client::builder()
            .timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self { base_url, client }
    }

    pub fn default_client() -> Self {
        Self::new(DEFAULT_DAEMON_PORT)
    }

    pub async fn is_running(&self) -> bool {
        match self
            .client
            .get(format!("{}/health", self.base_url))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn is_extension_connected(&self) -> bool {
        match self
            .client
            .get(format!("{}/status", self.base_url))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(data) = resp.json::<Value>().await {
                    data.get("extensionConnected")
                        .or_else(|| data.get("extension"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    pub async fn send_command(&self, cmd: &DaemonCommand) -> Ai00XResult<DaemonResult> {
        let client = Client::builder()
            .timeout(Duration::from_millis(cmd.timeout_ms.saturating_add(5000)))
            .build()
            .map_err(|e| Ai00XError::Service(e.to_string()))?;

        let resp = client
            .post(format!("{}/command", self.base_url))
            .header("X-Ai00X", "1")
            .header("Content-Type", "application/json")
            .json(cmd)
            .send()
            .await
            .map_err(|e| Ai00XError::Service(format!("Daemon command failed: {e}")))?;

        let status = resp.status();
        if status == StatusCode::SERVICE_UNAVAILABLE {
            let body = resp.text().await.unwrap_or_default();
            return Err(Ai00XError::Service(format!(
                "Extension not connected: {body}"
            )));
        }
        if status == StatusCode::GATEWAY_TIMEOUT {
            return Err(Ai00XError::Service(
                "Command timed out waiting for extension response".to_string(),
            ));
        }

        let result: DaemonResult = resp
            .json()
            .await
            .map_err(|e| Ai00XError::Service(format!("Failed to parse daemon response: {e}")))?;

        if !result.ok {
            if let Some(error) = &result.error {
                return Err(Ai00XError::Service(error.clone()));
            }
        }

        Ok(result)
    }

    pub async fn get_cookies(&self, domain: &str) -> Ai00XResult<Vec<CdpCookie>> {
        let cmd = DaemonCommand {
            id: format_uuid(),
            action: "cookies".to_string(),
            params: json!({ "domain": domain }),
            timeout_ms: 10000,
        };

        let result = self.send_command(&cmd).await?;

        if let Some(data) = result.data {
            let cookies: Vec<CdpCookie> = serde_json::from_value(data)
                .map_err(|e| Ai00XError::Service(format!("Failed to parse cookies: {e}")))?;
            Ok(cookies)
        } else {
            Ok(vec![])
        }
    }

    pub async fn navigate(&self, url: &str, workspace: Option<&str>) -> Ai00XResult<Value> {
        let mut params = json!({ "url": url });
        if let Some(ws) = workspace {
            params["workspace"] = json!(ws);
        }

        let cmd = DaemonCommand {
            id: format_uuid(),
            action: "navigate".to_string(),
            params,
            timeout_ms: 30000,
        };

        let result = self.send_command(&cmd).await?;
        Ok(result.data.unwrap_or(Value::Null))
    }

    pub async fn evaluate(&self, expression: &str, workspace: Option<&str>) -> Ai00XResult<Value> {
        let mut params = json!({ "code": expression });
        if let Some(ws) = workspace {
            params["workspace"] = json!(ws);
        }

        let cmd = DaemonCommand {
            id: format_uuid(),
            action: "exec".to_string(),
            params,
            timeout_ms: 30000,
        };

        let result = self.send_command(&cmd).await?;
        Ok(result.data.unwrap_or(Value::Null))
    }

    pub async fn read_article(&self, url: &str, workspace: Option<&str>) -> Ai00XResult<Value> {
        let mut params = json!({ "url": url });
        if let Some(ws) = workspace {
            params["workspace"] = json!(ws);
        }

        let cmd = DaemonCommand {
            id: format_uuid(),
            action: "read-article".to_string(),
            params,
            timeout_ms: 60000,
        };

        let result = self.send_command(&cmd).await?;
        Ok(result.data.unwrap_or(Value::Null))
    }

    pub async fn screenshot(&self, workspace: Option<&str>) -> Ai00XResult<String> {
        let mut params = json!({ "format": "jpeg", "quality": 80 });
        if let Some(ws) = workspace {
            params["workspace"] = json!(ws);
        }

        let cmd = DaemonCommand {
            id: format_uuid(),
            action: "screenshot".to_string(),
            params,
            timeout_ms: 15000,
        };

        let result = self.send_command(&cmd).await?;
        result
            .data
            .and_then(|d| d.as_str().map(String::from))
            .ok_or_else(|| Ai00XError::Service("No screenshot data returned".to_string()))
    }

    pub async fn cdp_command(
        &self,
        method: &str,
        params: Value,
        workspace: Option<&str>,
    ) -> Ai00XResult<Value> {
        let mut cmd_params = json!({ "cdpMethod": method, "cdpParams": params });
        if let Some(ws) = workspace {
            cmd_params["workspace"] = json!(ws);
        }

        let cmd = DaemonCommand {
            id: format_uuid(),
            action: "cdp".to_string(),
            params: cmd_params,
            timeout_ms: 15000,
        };

        let result = self.send_command(&cmd).await?;
        Ok(result.data.unwrap_or(Value::Null))
    }
}

fn format_uuid() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpCookie {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub httpOnly: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expirationDate: Option<f64>,
}

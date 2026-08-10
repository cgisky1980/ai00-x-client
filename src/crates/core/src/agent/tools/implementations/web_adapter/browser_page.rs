use async_trait::async_trait;
use serde_json::Value;

use crate::util::errors::Ai00XResult;

#[async_trait]
pub trait BrowserPage: Send + Sync {
    async fn navigate(&self, url: &str) -> Ai00XResult<Value>;
    async fn evaluate(&self, expression: &str) -> Ai00XResult<Value>;
    async fn screenshot(&self) -> Ai00XResult<String>;
    async fn get_cookies(&self, domain: &str) -> Ai00XResult<Vec<CookieInfo>>;
    async fn click(&self, selector: &str) -> Ai00XResult<Value>;
    async fn fill(&self, selector: &str, value: &str) -> Ai00XResult<Value>;
    async fn wait_for(&self, ms: u64) -> Ai00XResult<Value>;
    async fn current_url(&self) -> Ai00XResult<String>;
    fn page_type(&self) -> BrowserPageType;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserPageType {
    Daemon,
    Cdp,
    Headless,
}

#[derive(Debug, Clone)]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub secure: bool,
    pub http_only: bool,
}

pub struct DaemonBrowserPage {
    client: crate::agent::tools::browser_control::DaemonClient,
    workspace: Option<String>,
}

impl DaemonBrowserPage {
    pub fn new(port: u16, workspace: Option<String>) -> Self {
        Self {
            client: crate::agent::tools::browser_control::DaemonClient::new(port),
            workspace,
        }
    }

    pub fn default_client(workspace: Option<String>) -> Self {
        Self {
            client: crate::agent::tools::browser_control::DaemonClient::default_client(),
            workspace,
        }
    }

    pub fn is_available(&self) -> bool {
        false
    }

    pub async fn is_available_async(&self) -> bool {
        self.client.is_running().await && self.client.is_extension_connected().await
    }
}

#[async_trait]
impl BrowserPage for DaemonBrowserPage {
    async fn navigate(&self, url: &str) -> Ai00XResult<Value> {
        self.client.navigate(url, self.workspace.as_deref()).await
    }

    async fn evaluate(&self, expression: &str) -> Ai00XResult<Value> {
        self.client
            .evaluate(expression, self.workspace.as_deref())
            .await
    }

    async fn screenshot(&self) -> Ai00XResult<String> {
        self.client.screenshot(self.workspace.as_deref()).await
    }

    async fn get_cookies(&self, domain: &str) -> Ai00XResult<Vec<CookieInfo>> {
        let cookies = self.client.get_cookies(domain).await?;
        Ok(cookies
            .into_iter()
            .map(|c| CookieInfo {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                http_only: c.httpOnly,
            })
            .collect())
    }

    async fn click(&self, selector: &str) -> Ai00XResult<Value> {
        let expr = format!("document.querySelector('{}')?.click()", selector);
        self.evaluate(&expr).await
    }

    async fn fill(&self, selector: &str, value: &str) -> Ai00XResult<Value> {
        let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
        let expr = format!(
            "(function(){{ var el = document.querySelector('{}'); if(!el) return {{error:'element not found'}}; el.value = '{}'; el.dispatchEvent(new Event('input',{{bubbles:true}})); return {{ok:true}}; }})()",
            selector, escaped
        );
        self.evaluate(&expr).await
    }

    async fn wait_for(&self, ms: u64) -> Ai00XResult<Value> {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        Ok(Value::Object(serde_json::Map::from_iter([(
            "waited_ms".to_string(),
            Value::Number(ms.into()),
        )])))
    }

    async fn current_url(&self) -> Ai00XResult<String> {
        let result = self.evaluate("window.location.href").await?;
        Ok(result.as_str().unwrap_or("").to_string())
    }

    fn page_type(&self) -> BrowserPageType {
        BrowserPageType::Daemon
    }
}

pub struct CdpBrowserPage {
    client: crate::agent::tools::browser_control::CdpClient,
}

impl CdpBrowserPage {
    pub async fn connect(port: u16) -> Ai00XResult<Self> {
        let client =
            crate::agent::tools::browser_control::CdpClient::connect_to_first_page(port).await?;
        Ok(Self { client })
    }
}

#[async_trait]
impl BrowserPage for CdpBrowserPage {
    async fn navigate(&self, url: &str) -> Ai00XResult<Value> {
        let actions = crate::agent::tools::browser_control::BrowserActions::new(&self.client);
        actions.navigate(url).await
    }

    async fn evaluate(&self, expression: &str) -> Ai00XResult<Value> {
        let actions = crate::agent::tools::browser_control::BrowserActions::new(&self.client);
        actions.evaluate(expression).await
    }

    async fn screenshot(&self) -> Ai00XResult<String> {
        let actions = crate::agent::tools::browser_control::BrowserActions::new(&self.client);
        let result = actions.screenshot().await?;
        Ok(result.as_str().unwrap_or("").to_string())
    }

    async fn get_cookies(&self, domain: &str) -> Ai00XResult<Vec<CookieInfo>> {
        let urls = Some(vec![format!("https://{domain}")]);
        let cookies = self.client.get_cookies(urls).await?;
        Ok(cookies
            .into_iter()
            .map(|c| CookieInfo {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure.unwrap_or(false),
                http_only: c.http_only.unwrap_or(false),
            })
            .collect())
    }

    async fn click(&self, selector: &str) -> Ai00XResult<Value> {
        let actions = crate::agent::tools::browser_control::BrowserActions::new(&self.client);
        actions.click(selector).await
    }

    async fn fill(&self, selector: &str, value: &str) -> Ai00XResult<Value> {
        let actions = crate::agent::tools::browser_control::BrowserActions::new(&self.client);
        actions.fill(selector, value).await
    }

    async fn wait_for(&self, ms: u64) -> Ai00XResult<Value> {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        Ok(Value::Object(serde_json::Map::from_iter([(
            "waited_ms".to_string(),
            Value::Number(ms.into()),
        )])))
    }

    async fn current_url(&self) -> Ai00XResult<String> {
        let actions = crate::agent::tools::browser_control::BrowserActions::new(&self.client);
        actions.get_url().await
    }

    fn page_type(&self) -> BrowserPageType {
        BrowserPageType::Cdp
    }
}

pub struct HeadlessBrowserPage;

impl Default for HeadlessBrowserPage {
    fn default() -> Self {
        Self::new()
    }
}

impl HeadlessBrowserPage {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl BrowserPage for HeadlessBrowserPage {
    async fn navigate(&self, _url: &str) -> Ai00XResult<Value> {
        Err(crate::util::errors::Ai00XError::Service(
            "Headless browser page does not support navigation directly".to_string(),
        ))
    }

    async fn evaluate(&self, _expression: &str) -> Ai00XResult<Value> {
        Err(crate::util::errors::Ai00XError::Service(
            "Headless browser page does not support evaluate directly".to_string(),
        ))
    }

    async fn screenshot(&self) -> Ai00XResult<String> {
        Err(crate::util::errors::Ai00XError::Service(
            "Headless browser page does not support screenshot directly".to_string(),
        ))
    }

    async fn get_cookies(&self, _domain: &str) -> Ai00XResult<Vec<CookieInfo>> {
        Ok(vec![])
    }

    async fn click(&self, _selector: &str) -> Ai00XResult<Value> {
        Err(crate::util::errors::Ai00XError::Service(
            "Headless browser page does not support click directly".to_string(),
        ))
    }

    async fn fill(&self, _selector: &str, _value: &str) -> Ai00XResult<Value> {
        Err(crate::util::errors::Ai00XError::Service(
            "Headless browser page does not support fill directly".to_string(),
        ))
    }

    async fn wait_for(&self, ms: u64) -> Ai00XResult<Value> {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        Ok(Value::Object(serde_json::Map::from_iter([(
            "waited_ms".to_string(),
            Value::Number(ms.into()),
        )])))
    }

    async fn current_url(&self) -> Ai00XResult<String> {
        Err(crate::util::errors::Ai00XError::Service(
            "Headless browser page does not have a URL".to_string(),
        ))
    }

    fn page_type(&self) -> BrowserPageType {
        BrowserPageType::Headless
    }
}

pub enum BrowserPageInstance {
    Daemon(DaemonBrowserPage),
    Cdp(CdpBrowserPage),
    Headless(HeadlessBrowserPage),
}

impl BrowserPageInstance {
    pub fn as_dyn(&self) -> &dyn BrowserPage {
        match self {
            Self::Daemon(p) => p,
            Self::Cdp(p) => p,
            Self::Headless(p) => p,
        }
    }
}

pub async fn create_browser_page(
    daemon_port: Option<u16>,
    cdp_port: Option<u16>,
    workspace: Option<String>,
) -> Ai00XResult<BrowserPageInstance> {
    if let Some(port) = daemon_port {
        let page = DaemonBrowserPage::new(port, workspace.clone());
        if page.is_available_async().await {
            log::info!("Using Daemon browser page on port {}", port);
            return Ok(BrowserPageInstance::Daemon(page));
        }
        log::info!("Daemon not available on port {}, trying CDP", port);
    }

    if let Some(port) = cdp_port {
        match CdpBrowserPage::connect(port).await {
            Ok(page) => {
                log::info!("Using CDP browser page on port {}", port);
                return Ok(BrowserPageInstance::Cdp(page));
            }
            Err(e) => {
                log::info!("CDP connection failed on port {}: {}", port, e);
            }
        }
    }

    let default_daemon = DaemonBrowserPage::default_client(workspace);
    if default_daemon.is_available_async().await {
        log::info!("Using default Daemon browser page");
        return Ok(BrowserPageInstance::Daemon(default_daemon));
    }

    Err(crate::util::errors::Ai00XError::Service(
        "No browser page available. Install the browser extension or start Chrome with --remote-debugging-port.".to_string(),
    ))
}

//! Browser control via Chrome DevTools Protocol (CDP) and Browser Helper Extension.
//!
//! Two connection modes:
//!
//! 1. **Extension + Daemon** (preferred): The Ai00-X Browser Helper Chrome Extension
//!    connects to a local Daemon server. Uses `chrome.debugger` API to dynamically
//!    attach to tabs without requiring `--remote-debugging-port`. Preserves the
//!    user's cookies, extensions, and login sessions with zero manual intervention.
//!
//! 2. **CDP direct** (fallback): Connects to the user's browser over a CDP WebSocket
//!    when the browser is launched with `--remote-debugging-port`. Requires the
//!    browser to be started with this flag.

pub mod actions;
pub mod browser_launcher;
pub mod cdp_client;
pub mod cdp_cookie;
pub mod daemon;
pub mod daemon_client;

pub use actions::BrowserActions;
pub use browser_launcher::BrowserLauncher;
pub use cdp_client::CdpClient;
pub use cdp_cookie::CdpCookie;
pub use daemon::{BrowserDaemon, DaemonCommand, DaemonResult, DaemonState, DEFAULT_DAEMON_PORT};
pub use daemon_client::{CdpCookie as DaemonCookie, DaemonClient};

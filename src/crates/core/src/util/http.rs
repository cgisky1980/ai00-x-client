//! Local HTTP client utilities.

/// Returns an HTTP client that bypasses the system proxy — **only for
/// requests to local loopback services** (`127.0.0.1` / `localhost`).
///
/// When a system proxy is enabled (Clash etc., e.g. `127.0.0.1:7897`),
/// reqwest hijacks even `http://127.0.0.1:*` requests; proxies generally do
/// not forward loopback traffic, so every request hangs in a retry storm
/// (2026-09-10 incident: dsh engine `:3210` hijacked → "plan creation chats
/// all failed regardless of model").
///
/// Remote requests must NOT use this — going through the user's proxy is
/// their network environment.
pub fn local_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

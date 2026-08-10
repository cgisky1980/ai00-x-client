use serde::{Deserialize, Serialize};

use super::cdp_client::CdpClient;
use crate::util::errors::Ai00XResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpCookie {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
}

impl CdpClient {
    pub async fn get_cookies(&self, urls: Option<Vec<String>>) -> Ai00XResult<Vec<CdpCookie>> {
        let mut params = serde_json::Map::new();
        if let Some(urls) = urls {
            params.insert(
                "urls".to_string(),
                serde_json::Value::Array(urls.into_iter().map(serde_json::Value::String).collect()),
            );
        }

        self.send("Network.enable", None).await.ok();
        let result = self
            .send(
                "Network.getCookies",
                Some(serde_json::Value::Object(params)),
            )
            .await?;

        let cookies = result
            .get("cookies")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| serde_json::from_value(c.clone()).ok())
                    .collect::<Vec<CdpCookie>>()
            })
            .unwrap_or_default();

        Ok(cookies)
    }

    pub async fn set_cookie(&self, cookie: &CdpCookie) -> Ai00XResult<serde_json::Value> {
        self.send("Network.enable", None).await.ok();

        let mut params = serde_json::Map::new();
        params.insert(
            "name".to_string(),
            serde_json::Value::String(cookie.name.clone()),
        );
        params.insert(
            "value".to_string(),
            serde_json::Value::String(cookie.value.clone()),
        );
        if let Some(ref domain) = cookie.domain {
            params.insert(
                "domain".to_string(),
                serde_json::Value::String(domain.clone()),
            );
        }
        if let Some(ref path) = cookie.path {
            params.insert("path".to_string(), serde_json::Value::String(path.clone()));
        }
        if let Some(secure) = cookie.secure {
            params.insert("secure".to_string(), serde_json::Value::Bool(secure));
        }
        if let Some(http_only) = cookie.http_only {
            params.insert("httpOnly".to_string(), serde_json::Value::Bool(http_only));
        }
        if let Some(ref same_site) = cookie.same_site {
            params.insert(
                "sameSite".to_string(),
                serde_json::Value::String(same_site.clone()),
            );
        }
        if let Some(expires) = cookie.expires {
            params.insert(
                "expires".to_string(),
                serde_json::Value::Number(
                    serde_json::Number::from_f64(expires).unwrap_or(serde_json::Number::from(0)),
                ),
            );
        }

        self.send("Network.setCookie", Some(serde_json::Value::Object(params)))
            .await
    }

    pub async fn delete_cookies(
        &self,
        name: Option<&str>,
        domain: Option<&str>,
    ) -> Ai00XResult<serde_json::Value> {
        self.send("Network.enable", None).await.ok();

        let mut params = serde_json::Map::new();
        if let Some(name) = name {
            params.insert(
                "name".to_string(),
                serde_json::Value::String(name.to_string()),
            );
        }
        if let Some(domain) = domain {
            params.insert(
                "domain".to_string(),
                serde_json::Value::String(domain.to_string()),
            );
        }

        self.send(
            "Network.deleteCookies",
            Some(serde_json::Value::Object(params)),
        )
        .await
    }
}

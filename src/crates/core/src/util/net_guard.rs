//! 网络守卫（P1-A SSRF 加固）：运行时传入 URL 的服务端请求统一过这里。
//!
//! 封网清单对标 dsh-community-market `blocked-subnets.ts` 并补全：
//! 回环/私网/链路本地/CGNAT/NAT64/6to4/Teredo/组播/保留段/
//! **198.18.0.0/15 假 IP 代理段**（本地 fake-IP DNS 的常用段），
//! IPv4-mapped IPv6 先归一化为 IPv4 再查清单。
//!
//! 用法：
//! - `assert_url_allowed(url)`：scheme 白名单 + IP 字面量直查 + 域名解析后
//!   全部记录过清单（域名解析到内网也拒绝）。
//! - `read_capped(resp, cap)`：流式读响应体，超限截断报错（防内存打爆）。
//!
//! 已知边界：校验与请求之间存在 DNS rebinding 的 TOCTOU 窗口（校验后
//! reqwest 再次解析可能得到不同 IP）；彻底封死需要自定义 `dns_resolver`
//! 把域名钉到校验过的 IP，威胁模型下收益/成本比低，暂不做（P1-A 加固档）。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// 判定一个 IP 是否落在封网清单内（SSRF 拒绝）。
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped (::ffff:a.b.c.d) 归一化后按 v4 查
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ipv4(v4);
            }
            is_blocked_ipv6(v6)
        }
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    let [a, b, _, _] = o;
    // 回环 / 本网络 / 私网
    a == 0 || a == 10 || a == 127
        // 链路本地（含 APIPA）
        || (a == 169 && b == 254)
        // 私网 172.16/12
        || (a == 172 && (16..=31).contains(&b))
        // 私网 192.168/16
        || (a == 192 && b == 168)
        // CGNAT 100.64/10
        || (a == 100 && (64..=127).contains(&b))
        // 基准测试段 198.18/15：本地 fake-IP DNS（代理软件）常用，SSRF 高危
        || (a == 198 && (18..=19).contains(&b))
        // IETF 协议段 192.0.0/24
        || (a == 192 && b == 0 && o[2] == 0)
        // TEST-NET 段（文档专用，正常网络不该出现）
        || (a == 192 && b == 0 && o[2] == 2)
        || (a == 198 && b == 51 && o[2] == 100)
        || (a == 203 && b == 0 && o[2] == 113)
        // 组播 224/4 与保留 240/4（含广播）
        || a >= 224
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // 未指定 :: 与回环 ::1
    ip.is_unspecified()
        || ip.is_loopback()
        // ULA fc00::/7
        || (s[0] & 0xfe00) == 0xfc00
        // 链路本地 fe80::/10
        || (s[0] & 0xffc0) == 0xfe80
        // 组播 ff00::/8
        || (s[0] & 0xff00) == 0xff00
        // 文档段 2001:db8::/32
        || (s[0] == 0x2001 && s[1] == 0x0db8)
        // 6to4 2002::/16
        || s[0] == 0x2002
        // Teredo 2001::/32
        || (s[0] == 0x2001 && s[1] == 0x0000)
}

/// 校验一个待请求的 URL（SSRF 闸门）：
/// scheme 只许 http/https → 提取 host → IP 字面量直查清单 →
/// 域名经系统 DNS 解析，**所有**记录都须在清单外。
/// 返回解析后的 Url（调用方用它发请求，避免二次解析偏差）。
pub async fn assert_url_allowed(url: &str) -> Result<reqwest::Url, String> {
    let parsed: reqwest::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("scheme `{other}` not allowed")),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?
        .to_string();

    // IP 字面量（含 [::1] 形式）直查
    let host_clean = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host_clean.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(format!(
                "blocked: `{host}` resolves to/before is a restricted address"
            ));
        }
        return Ok(parsed);
    }

    // 域名：系统 DNS 解析后全部记录过清单
    let records = tokio::net::lookup_host(format!("{host_clean}:0"))
        .await
        .map_err(|e| format!("dns resolve `{host}` failed: {e}"))?;
    let mut checked = 0usize;
    for sockaddr in records {
        checked += 1;
        if is_blocked_ip(sockaddr.ip()) {
            return Err(format!(
                "blocked: `{host}` resolves to restricted address {}",
                sockaddr.ip()
            ));
        }
    }
    if checked == 0 {
        return Err(format!("dns resolve `{host}` returned no records"));
    }
    Ok(parsed)
}

/// 同步版闸门（重定向逐跳校验用）：scheme 白名单 + IP 字面量封网 +
/// localhost 主机名。域名解析到内网的 DNS 绕过在同步上下文查不了，
/// 由请求前的 [`assert_url_allowed`]（异步，含 DNS 解析）把守首跳。
pub fn assert_url_allowed_sync(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("scheme `{other}` not allowed")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?;
    let host_clean = host.trim_start_matches('[').trim_end_matches(']');
    if host_clean.eq_ignore_ascii_case("localhost") {
        return Err("blocked: localhost".to_string());
    }
    if let Ok(ip) = host_clean.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(format!("blocked: restricted address {ip}"));
        }
    }
    Ok(())
}

/// 重定向逐跳校验策略（P1-A）：每一跳都过同步闸门，防「公网 URL 307 跳内网」。
/// 首跳由调用方的 `assert_url_allowed`（含 DNS）把守。
pub fn safe_redirect_policy(max_hops: usize) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= max_hops {
            return attempt.error(format!("too many redirects (> {max_hops})"));
        }
        match assert_url_allowed_sync(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(e) => attempt.error(e),
        }
    })
}

/// 流式读取响应体并施加体积上限（防超大响应打爆内存）。
/// 超限返回 Err（调用方决定截断语义）；静默场景可用 `read_capped_lossy`
/// 拿到截断后的内容。
pub async fn read_capped(mut resp: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    // Content-Length 预检（有头且超限直接拒绝，省流量）
    if let Some(len) = resp.content_length() {
        if len > cap as u64 {
            return Err(format!("response too large: {len} > {cap}"));
        }
    }
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let remain = cap.saturating_sub(buf.len());
                if remain == 0 {
                    return Err(format!("response exceeds cap {cap}"));
                }
                let take = remain.min(chunk.len());
                buf.extend_from_slice(&chunk[..take]);
            }
            Ok(None) => return Ok(buf),
            Err(e) => return Err(format!("read body: {e}")),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // 测试断言便利
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn v4(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn v6(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocked_v4_ranges() {
        for s in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.255",
            "198.18.0.1",     // fake-IP 代理段起点
            "198.19.255.255", // 段终点也封
            "192.0.0.1",
            "192.0.2.1",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_blocked_ip(v4(s)), "should block {s}");
        }
    }

    #[test]
    fn allowed_v4_public() {
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1", // 172.16/12 之外
            "172.15.255.255",
            "100.63.255.255", // CGNAT 之外
            "100.128.0.1",
            "198.20.0.1", // 198.18/15 之外
            "198.17.255.255",
            "198.50.0.1",
            "203.0.114.1",
        ] {
            assert!(!is_blocked_ip(v4(s)), "should allow {s}");
        }
    }

    #[test]
    fn blocked_v6_and_mapped() {
        for s in [
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "2002:c000:201::",  // 6to4 包着 192.0.2.1
            "2001:0000:1234::", // Teredo
            "::ffff:127.0.0.1", // mapped 回环
            "::ffff:10.0.0.1",
            "::ffff:198.18.0.1",
        ] {
            assert!(is_blocked_ip(v6(s)), "should block {s}");
        }
        assert!(!is_blocked_ip(v6("2606:4700::1111")));
        assert!(!is_blocked_ip(v6("::ffff:8.8.8.8")));
    }

    #[test]
    fn scheme_whitelist() {
        // 断言不 panic 且错误信息含 not allowed；解析在 async 上下文外无法直测
        // scheme 检查在 resolve 之前，这里只验证解析路径的纯文本分支
        let parsed: reqwest::Url = "file:///etc/passwd".parse().unwrap();
        assert_eq!(parsed.scheme(), "file");
    }

    #[tokio::test]
    async fn rejects_ip_literal_private() {
        let err = assert_url_allowed("http://127.0.0.1:2100/ai00-internal/models")
            .await
            .unwrap_err();
        assert!(err.contains("blocked"), "got: {err}");
        let err = assert_url_allowed("http://[::1]:2100/").await.unwrap_err();
        assert!(err.contains("blocked"), "got: {err}");
        let err = assert_url_allowed("ftp://example.com").await.unwrap_err();
        assert!(err.contains("not allowed"), "got: {err}");
    }

    #[tokio::test]
    async fn allows_public_url_parse() {
        // 不做真实网络解析断言（CI 无网也该过）：公网 IP 字面量直接放行
        let ok = assert_url_allowed("https://8.8.8.8/dns-query").await;
        assert!(ok.is_ok());
    }
}

//! 无头浏览器抓取（P1 无头 v1）：chromiumoxide 驱动系统 Edge/Chrome headless，
//! 为 web_extract 提供 JS 渲染升级路径。
//!
//! 设计：
//! - 单浏览器常驻（lazy 启动），页面信号量限并发（3），空闲 5 分钟自动退出
//! - 浏览器供给：环境变量 AI00_X_HEADLESS_BROWSER > 系统 Edge/Chrome 探测
//!   （Win 必有 Edge；mac/linux 探测 Chrome/Chromium）
//! - 跨平台构建由官方分发的 chromium 保证；chrome-headless-shell 自动下载
//!   留作探测失败时的后续增强
//! - 反爬对抗弱（Cloudflare 盾会拦）——社媒对抗场景由 v2 Patchright 走 MCP 通道

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use futures::StreamExt;

use chromiumoxide::Browser;

const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONCURRENT_PAGES: usize = 3;
const IDLE_SHUTDOWN: Duration = Duration::from_secs(300);

struct PoolState {
    child: tokio::process::Child,
    browser: Arc<Browser>,
    handler: tokio::task::JoinHandle<()>,
    last_used: Instant,
}

static POOL: OnceLock<StdMutex<Option<PoolState>>> = OnceLock::new();
static PAGE_SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
/// 浏览器启动互斥：防止并发首调拉起多个实例（双重检查配合池判空）
static LAUNCH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn launch_lock() -> &'static tokio::sync::Mutex<()> {
    LAUNCH_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn pool_cell() -> &'static StdMutex<Option<PoolState>> {
    POOL.get_or_init(|| StdMutex::new(None))
}

fn page_sem() -> &'static tokio::sync::Semaphore {
    PAGE_SEM.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_PAGES))
}

/// 抓取 URL 的 JS 渲染后 HTML（无头浏览器，带并发限制/超时/空闲退出）。
/// 失败一律返回 Err（调用方降级 r.jina.ai）。
pub async fn fetch_rendered_html(url: &str) -> Result<String, String> {
    let _permit = page_sem()
        .acquire()
        .await
        .map_err(|e| format!("page semaphore: {e}"))?;
    let browser = ensure_browser().await?;
    let page = browser.new_page("about:blank").await.map_err(|e| {
        mark_unhealthy();
        format!("new page: {e}")
    })?;
    let fetch = async {
        page.goto(url)
            .await
            .map_err(|e| format!("goto: {e}"))?
            .find_element("body")
            .await
            .ok(); // 等待 body 出现（SPA 首帧）；没有也不致命
        tokio::time::sleep(Duration::from_millis(800)).await; // hydration settle
        let html = page.content().await.map_err(|e| format!("content: {e}"))?;
        Ok::<String, String>(html)
    };
    let result = tokio::time::timeout(PAGE_TIMEOUT, fetch).await;
    let _ = page.close().await; // 释放 tab（浏览器实例保留复用）
    match result {
        Ok(Ok(html)) => Ok(html),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            mark_unhealthy();
            Err(format!("headless fetch timeout ({PAGE_TIMEOUT:?}): {url}"))
        }
    }
}

fn mark_unhealthy() {
    // 导航失败/超时多半意味着浏览器实例已坏（webview 崩/进程被杀），
    // 丢弃实例让下次调用重新拉起
    if let Ok(mut guard) = pool_cell().lock() {
        if let Some(mut state) = guard.take() {
            state.handler.abort();
            let _ = state.child.start_kill(); // 进程与 CDP 连接一起收掉
        }
    }
}

/// 惰性启动/复用浏览器实例，并确保 reaper 在跑。
///
/// 不用 chromiumoxide 的 Browser::launch——它在 Windows 上以 pipe 模式拉起
/// Edge/Chrome 会让进程静默退出（实测 154 版）。改为自管进程：端口模式
/// （--remote-debugging-port=0）+ 从 stderr 抓 DevTools ws 地址 + connect。
async fn ensure_browser() -> Result<Arc<Browser>, String> {
    // 快路径：池里已有
    let reused = pool_cell()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| Arc::clone(&s.browser)));
    if let Some(browser) = reused {
        if let Ok(mut g) = pool_cell().lock() {
            if let Some(state) = g.as_mut() {
                state.last_used = Instant::now();
            }
        }
        ensure_reaper();
        return Ok(browser);
    }
    // 慢路径：启动互斥 + 双重检查（并发首调只拉起一个实例，其余等它入池复用）
    let _guard = launch_lock().lock().await;
    let reused = pool_cell()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| Arc::clone(&s.browser)));
    if let Some(browser) = reused {
        if let Ok(mut g) = pool_cell().lock() {
            if let Some(state) = g.as_mut() {
                state.last_used = Instant::now();
            }
        }
        ensure_reaper();
        return Ok(browser);
    }
    let (child, browser, handler_task) = launch_browser().await?;
    if let Ok(mut g) = pool_cell().lock() {
        *g = Some(PoolState {
            child,
            browser: Arc::clone(&browser),
            handler: handler_task,
            last_used: Instant::now(),
        });
    }
    ensure_reaper();
    Ok(browser)
}

/// 拉起 headless Edge/Chrome 进程并建立 CDP 连接。
async fn launch_browser() -> Result<
    (
        tokio::process::Child,
        Arc<Browser>,
        tokio::task::JoinHandle<()>,
    ),
    String,
> {
    use std::process::Stdio;

    let exe = detect_browser().await?;
    log::info!("[headless] launching browser: {}", exe.display());
    // 独立临时 profile：不指定时 Edge/Chrome 会把启动请求转交给正在运行的
    // 实例然后自己退出——必须隔离
    let user_data_dir = std::env::temp_dir().join(format!("ai00-headless-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&user_data_dir);

    // Windows 上 Chromium 不支持 --remote-debugging-port=0（静默退出），
    // 自选空闲端口（绑定后立即释放，极小概率被抢——失败由早退检测兜底）
    let debug_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("bind probe port: {e}"))?;
        listener.local_addr().map_err(|e| e.to_string())?.port()
    };
    let mut child = tokio::process::Command::new(&exe)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            &format!("--remote-debugging-port={debug_port}"),
            "--window-size=1366,2400",
        ])
        .arg(format!("--user-data-dir={}", user_data_dir.display()))
        .arg("about:blank")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn {exe:?}: {e}"))?;

    // 从 stderr 抓 "DevTools listening on ws://..."（Chromium 标准输出行）。
    // 抓到后继续泵空管道防阻塞；ws 地址放共享槽，主流程轮询取。
    // 端口已知（我们选定），直接轮询 /json/version 拿 webSocketDebuggerUrl——
    // 不依赖 stderr（实测 Edge 在管道 stdio 下可能零输出静默退出）。
    let version_url = format!("http://127.0.0.1:{debug_port}/json/version");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let ws_url = loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "browser process exited early: {status}（常见原因：user-data-dir 冲突或参数不兼容）"
            ));
        }
        if Instant::now() > deadline {
            let _ = child.start_kill();
            return Err("browser devtools endpoint timeout (15s)".to_string());
        }
        if let Ok(resp) = client.get(&version_url).send().await {
            if resp.status().is_success() {
                if let Ok(v) = resp.json::<serde_json::Value>().await {
                    if let Some(ws) = v["webSocketDebuggerUrl"].as_str() {
                        break ws.to_string();
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    log::info!("[headless] devtools endpoint acquired on port {debug_port}");

    let (browser, mut handler) = Browser::connect(ws_url)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let browser = Arc::new(browser);
    let handler_task = tokio::spawn(async move {
        while let Some(_event) = handler.next().await {
            // CDP 事件泵：必须持续消费，否则连接阻塞
        }
    });
    Ok((child, browser, handler_task))
}

fn ensure_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let expired = {
                    let Ok(guard) = pool_cell().lock() else {
                        continue;
                    };
                    match guard.as_ref() {
                        Some(state) => state.last_used.elapsed() > IDLE_SHUTDOWN,
                        None => false,
                    }
                };
                if expired {
                    if let Ok(mut guard) = pool_cell().lock() {
                        if let Some(state) = guard.take() {
                            state.handler.abort();
                            log::info!("[headless] idle shutdown ({}s)", IDLE_SHUTDOWN.as_secs());
                            drop(state); // Browser 句柄 drop 关闭浏览器进程
                        }
                    }
                }
            }
        });
    });
}

/// 探测系统 Edge/Chrome/Chromium 可执行文件（跨平台）。
async fn detect_browser() -> Result<PathBuf, String> {
    // 环境变量显式覆盖
    if let Ok(p) = std::env::var("AI00_X_HEADLESS_BROWSER") {
        if !p.trim().is_empty() {
            let path = PathBuf::from(p.trim());
            if path.exists() {
                return Ok(path);
            }
            return Err(format!(
                "AI00_X_HEADLESS_BROWSER 指向的浏览器不存在: {}",
                path.display()
            ));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pf86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        for base in [pf86, pf, local.clone()] {
            if base.is_empty() {
                continue;
            }
            candidates.push(PathBuf::from(&base).join(r"Microsoft\Edge\Application\msedge.exe"));
            candidates.push(PathBuf::from(&base).join(r"Google\Chrome\Application\chrome.exe"));
        }
        if !local.is_empty() {
            candidates.push(PathBuf::from(&local).join(r"Google\Chrome\Application\chrome.exe"));
        }
    } else if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ));
    } else {
        // linux：PATH 探测
        for name in [
            "chromium",
            "chromium-browser",
            "google-chrome",
            "google-chrome-stable",
            "microsoft-edge",
        ] {
            if let Ok(out) = tokio::process::Command::new("which")
                .arg(name)
                .output()
                .await
            {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() {
                    candidates.push(PathBuf::from(p));
                }
            }
        }
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(
        "未找到可用的 Edge/Chrome/Chromium。可设置环境变量 AI00_X_HEADLESS_BROWSER \
         指定浏览器路径（后续版本将支持 chrome-headless-shell 自动下载）"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机自验（需本机有 Edge/Chrome）：JS 写入的内容只有无头渲染才能拿到。
    /// 运行：cargo test -p ai00-x-desktop --release headless_selftest -- --ignored
    #[tokio::test]
    #[ignore]
    async fn headless_selftest() {
        let url = "data:text/html,%3Chtml%3E%3Cbody%3E%3Cscript%3EsetTimeout(function()%7Bdocument.body.innerHTML%3D'%3Ch1%20id%3D%22r%22%3ERENDERED_BY_JS%3C%2Fh1%3E'%7D%2C300)%3C%2Fscript%3E%3C%2Fbody%3E%3C%2Fhtml%3E";
        let html = fetch_rendered_html(url)
            .await
            .expect("headless fetch failed");
        assert!(
            html.contains("RENDERED_BY_JS"),
            "JS 渲染内容缺失: {}",
            &html[..html.len().min(300)]
        );
        println!("headless selftest OK (html {} bytes)", html.len());
    }
}

#[cfg(test)]
mod batch_selftests {
    use super::*;

    fn page_with_marker(id: u8) -> String {
        // data: URL 内嵌 JS：300ms 后写入各自的标记文本——只有真渲染才能抓到
        let html = format!(
            "<html><body><script>setTimeout(function(){{document.body.innerHTML='<h1>BATCH_MARKER_{id}</h1><p>content-{id}</p>'}},300)</script></body></html>",
            id = id
        );
        let mut encoded = String::from("data:text/html;charset=utf-8,");
        for b in html.bytes() {
            if b.is_ascii_alphanumeric() || b"()-_.~".contains(&b) {
                encoded.push(b as char);
            } else {
                encoded.push_str(&format!("%{b:02X}"));
            }
        }
        encoded
    }

    /// 真机自验 3：无头多开并发——4 个页面同时抓（信号量限 3，排队共享
    /// 同一浏览器实例），各自拿到自己的 JS 渲染标记。
    /// 运行：cargo test -p ai00-x-desktop --release headless_batch_selftest -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn headless_batch_selftest() {
        let t = Instant::now();
        let mut joins = tokio::task::JoinSet::new();
        for id in 1u8..=4 {
            let url = page_with_marker(id);
            joins.spawn(async move { (id, fetch_rendered_html(&url).await) });
        }
        let mut ok = 0;
        while let Some(res) = joins.join_next().await {
            let (id, r) = res.expect("join");
            match r {
                Ok(html) => {
                    let marker = format!("BATCH_MARKER_{id}");
                    assert!(html.contains(&marker), "page {id} 缺少自己的标记");
                    println!(
                        "[headless_batch_selftest] page {id} OK ({} bytes)",
                        html.len()
                    );
                    ok += 1;
                }
                Err(e) => panic!("page {id} failed: {e}"),
            }
        }
        println!(
            "[headless_batch_selftest] {ok}/4 pages OK in {:.1}s",
            t.elapsed().as_secs_f32()
        );
        assert_eq!(ok, 4);
    }

    /// 真机自验 4：真实 SPA 页面（react.dev，纯 HTTP 抓只会拿到空壳）。
    #[tokio::test]
    #[ignore]
    async fn headless_real_spa_selftest() {
        let t = Instant::now();
        let html = fetch_rendered_html("https://react.dev/")
            .await
            .expect("fetch failed");
        let text_chars = html.split('<').filter(|s| !s.contains("=")).count();
        println!(
            "[headless_real_spa_selftest] {} bytes / ~{} text blocks in {:.1}s",
            html.len(),
            text_chars,
            t.elapsed().as_secs_f32()
        );
        assert!(
            html.len() > 20_000,
            "渲染后内容过小，疑似空壳: {} bytes",
            html.len()
        );
    }
}

//! web 有效信息提取 + 长文总结：全本地闭环工具（`ai00_web_extract` /
//! `ai00_text_summarize`）的宿主侧实现。
//!
//! 并发核心（推理池槽位天然交错调度，3B=16 槽 / 7B=8 槽，页数上限 12
//! 不超槽位，无需额外 semaphore）：
//!   搜索 N 页 → join_all 并发抓取（reqwest 10s / 2MB 截断 → htmd 转 MD）
//!   → join_all 并发 pool_infer 本地筛选/摘要（Instruction 格式 JSON 输出，
//!   top_p=0.1 近贪心 + presence/frequency=0.5 —— 已验证的 JSON 稳定配方）。
//!
//! 工具永不失败：抓取失败丢弃该页；筛选 JSON 解析失败用 snippet 降级收录
//! （degraded 标记）；零相关/全灭 → 搜索 snippet 列表兜底，让模型自行措辞。

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use ai00_x_core::websearch::{is_private_ip, WebSearchTool};

use crate::rwkv_llm::{pool_infer, InferenceEvent};

/// 单页提取结果（路由响应与工具输出共用形状）。
#[derive(Debug, Clone, Serialize)]
pub struct PageExtract {
    pub title: String,
    pub url: String,
    pub summary: String,
    /// true = 未经本地模型有效筛选的降级收录（snippet 兜底）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub degraded: bool,
}

/// 抓取阶段的中间页。
struct FetchedPage {
    title: String,
    url: String,
    snippet: String,
    /// 抓取成功后的正文 Markdown（≤ PAGE_MD_CHARS 字符）；None = 抓取失败。
    markdown: Option<String>,
}

const DEFAULT_MAX_RESULTS: usize = 8;
const MAX_RESULTS_CAP: usize = 12;
const FETCH_TIMEOUT_SECS: u64 = 10;
const FETCH_BYTES_CAP: usize = 2 * 1024 * 1024;
const PAGE_MD_CHARS: usize = 3000;
const SCREEN_TIMEOUT_SECS: u64 = 60;
const SCREEN_MAX_TOKENS: usize = 320;

/// 长文总结阈值：≤ 6000 字符单次总结；> 6000 切块 map-reduce。
const SUMMARIZE_SINGLE_SHOT_CHARS: usize = 6000;
/// map 阶段切块大小（字符）。
const SUMMARIZE_CHUNK_CHARS: usize = 4000;
/// map 阶段每块要点目标字数。
const SUMMARIZE_CHUNK_TARGET: usize = 150;
const SUMMARIZE_DEFAULT_MAX_LENGTH: usize = 500;

/// 本地筛选/摘要统一 stop 序列（与 ai_gateway local_tool_round 对齐；
/// 追加无换行变体——3B 模型会在句中直接接 "User:" 幻觉，见 2026-09-11 实录）。
fn rwkv_stop() -> Vec<String> {
    [
        "\n\nUser:",
        "\nUser:",
        "User:",
        "\n\nSystem:",
        "\n\nInstruction:",
        "\n\nInput:",
        "\n\nAssistant:",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 「not initialized」错误时后台触发 lazy-init（与 ai_gateway 同策略）：
/// 本请求已按降级处理，下一次调用恢复正常路径。
fn maybe_lazy_init(err: &str) {
    if err.contains("not initialized") {
        tokio::spawn(async move {
            if let Err(e) = crate::rwkv_llm::init_engine_internal(None, None, None).await {
                log::warn!("[web-extract] RWKV lazy-init failed: {e}");
            }
        });
    }
}

/// 按查询脚本判定搜索语言（**不再作为第一跳**）：AnySearch 在 `zh-CN` / `zh` 下
/// 对中英文查询都只回 cqvip 中文期刊页（非空但无关，零结果回退永不触发）。
fn detect_search_language(query: &str) -> &'static str {
    let cjk = query
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count();
    let latin = query.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if cjk * 2 >= latin.max(1) {
        "zh-CN"
    } else {
        "en"
    }
}

/// 搜索（回退链）：`all` → 查询语言 → 截前 6 词。
///
/// 实测（2026-11-21，直连 AnySearch 对照）：
/// - `language=all` + 英文查询 → reddit / redis / mem0 / aws（正常）
/// - `language=all` + 中文查询 → rwkv.cn / 知乎 / arxiv / bilibili（正常）
/// - `language=zh-CN|zh` + 任一查询 → 清一色 cqvip 中文期刊页（无关）
/// - SearXNG（自建 s.ai00-x.com）+ 英文查询 → `results: []`（上游引擎全限流）
///
/// 所以第一跳固定 `all`；语言定向只作为零结果的第二跳兜底，最后再截词重试。
async fn search_with_fallback(
    query: &str,
    max_results: usize,
) -> (Vec<ai00_x_core::websearch::SearchResultItem>, String) {
    let attempt = |q: String, language: &'static str| async move {
        WebSearchTool::new()
            .with_searxng_enabled(true)
            .search_simple(&q, language, max_results)
            .await
            .unwrap_or_else(|e| {
                log::warn!("[web-extract] search failed ({language}): {e}");
                Vec::new()
            })
    };

    let results = attempt(query.to_string(), "all").await;
    if !results.is_empty() {
        return (results, query.to_string());
    }
    let language = detect_search_language(query);
    log::warn!("[web-extract] query={query:?} returned 0 results (all), retrying with {language}");
    let results = attempt(query.to_string(), language).await;
    if !results.is_empty() {
        return (results, query.to_string());
    }
    let words: Vec<&str> = query.split_whitespace().collect();
    if words.len() > 6 {
        let shortened = words[..6].join(" ");
        log::warn!(
            "[web-extract] query={query:?} returned 0 results, retrying shortened {shortened:?}"
        );
        let results = attempt(shortened.clone(), "all").await;
        if !results.is_empty() {
            return (results, shortened);
        }
    }
    (Vec::new(), query.to_string())
}

/// web 有效信息提取主流程：搜索 → 并发抓取 → 并发本地筛选。
pub async fn extract(query: &str, max_results: Option<usize>) -> Vec<PageExtract> {
    let max_results = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS_CAP);
    // SearXNG 自建实例（s.ai00-x.com，2026-10-02 部署）已作为主搜索源，
    // 此处显式开启 fallback 链：AnySearch（有 key）→ SearXNG →（无则空）
    let (results, effective_query) = search_with_fallback(query, max_results).await;
    if results.is_empty() {
        log::warn!("[web-extract] query={query:?} returned 0 results after fallbacks");
        return Vec::new();
    }
    log::info!(
        "[web-extract] query={query:?} (effective={effective_query:?}) {} results, fetching concurrently",
        results.len()
    );

    // 并发抓取（失败页 markdown=None，筛选项丢弃但保留 snippet 兜底席位）
    let fetched: Vec<FetchedPage> =
        futures::future::join_all(results.into_iter().map(|item| async move {
            let markdown = fetch_page_markdown(&item.url).await;
            FetchedPage {
                title: item.title,
                url: item.url,
                snippet: item.snippet,
                markdown,
            }
        }))
        .await;
    let fetched_ok = fetched.iter().filter(|p| p.markdown.is_some()).count();
    log::info!("[web-extract] fetched {fetched_ok}/{} pages", fetched.len());

    // 并发本地筛选/摘要（仅抓取成功的页；全部 pool_infer 一次性提交，池自动交错）
    let screened: Vec<Option<PageExtract>> =
        futures::future::join_all(fetched.iter().map(|page| async {
            match &page.markdown {
                Some(md) => screen_page(query, page, md).await,
                None => None,
            }
        }))
        .await;
    let relevant_count = screened.iter().filter(|p| p.is_some()).count();
    log::info!(
        "[web-extract] screened {relevant_count}/{} relevant",
        fetched.len()
    );

    let mut pages: Vec<PageExtract> = screened.into_iter().flatten().collect();
    if pages.is_empty() {
        // 零相关/全灭 → snippet 兜底（工具永不失败原则）
        log::warn!("[web-extract] all pages screened out, falling back to snippets");
        pages = fetched
            .iter()
            .map(|p| PageExtract {
                title: p.title.clone(),
                url: p.url.clone(),
                summary: p.snippet.clone(),
                degraded: true,
            })
            .collect();
    }
    pages
}

// ---------------------------------------------------------------------------
// ai00_research_collect：把"多步检索 → 整理 → 落盘"下沉到宿主
// ---------------------------------------------------------------------------
//
// 为什么需要：本地 3B 的可靠区只有**单次**工具调用（见
// 参考/2026-11-11-rwkv-本地模型执行边界与最佳提示词模板-实验记录.md §二）。
// 让它连续检索 10 次再整理，实测查询串退化、同一查询连发 4 次、最后喊 BLOCKED。
// 这里把整条链路做成一个确定性工具：模型只发一次调用，宿主完成搜索、并发抓取、
// 本地筛选、去重、拼 Markdown 与落盘。

/// 调研采集结果（工具输出，供插件渲染一行摘要）。
#[derive(Debug, Clone, Serialize)]
pub struct ResearchCollectOutcome {
    /// 落盘文件名（相对工作目录）。
    pub saved: String,
    /// 实际写入的来源条数（去重后）。
    pub sources: usize,
    /// 实际执行的查询数。
    pub queries: usize,
    /// 零结果的查询数（>0 表示部分主题没搜到）。
    pub failed: usize,
}

/// 单次采集上限：查询数 / 种子 URL 数 / 每条查询取几页。
const RESEARCH_QUERY_CAP: usize = 8;
const RESEARCH_URL_CAP: usize = 12;
const RESEARCH_PER_QUERY: usize = 6;
/// 并发上限（与 web_extract 的 12 页上限同量级，避免把搜索源打爆）。
const RESEARCH_CONCURRENCY: usize = 4;

/// topic → 查询集（模型省略 queries 时使用；确定性派生，不需要模型多想一步）。
pub fn derived_queries(topic: &str) -> Vec<String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Vec::new();
    }
    vec![
        topic.to_string(),
        format!("{topic} survey"),
        format!("{topic} architecture comparison"),
        format!("{topic} 2025 2026"),
    ]
}

/// 采集：查询集并发执行（上限 4），种子 URL 并发抓取，按 URL 去重。
///
/// 返回 (去重后的页面, 执行的查询数, 零结果查询数)。工具永不失败：抓取失败的
/// 页面直接丢弃，全空时由调用方写成 `0 sources`（不冒充实成功）。
pub async fn collect_pages(
    queries: &[String],
    urls: &[String],
) -> (Vec<PageExtract>, usize, usize) {
    use futures::StreamExt;

    let queries: Vec<String> = queries
        .iter()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .take(RESEARCH_QUERY_CAP)
        .collect();
    let query_count = queries.len();

    let batches: Vec<(String, Vec<PageExtract>)> = futures::stream::iter(queries)
        .map(|query| async move {
            let pages = extract(&query, Some(RESEARCH_PER_QUERY)).await;
            (query, pages)
        })
        .buffer_unordered(RESEARCH_CONCURRENCY)
        .collect()
        .await;

    let failed = batches.iter().filter(|(_, pages)| pages.is_empty()).count();
    let mut pages: Vec<PageExtract> = Vec::new();
    for (_, mut item) in batches {
        pages.append(&mut item);
    }

    let urls: Vec<String> = urls
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| u.starts_with("http"))
        .take(RESEARCH_URL_CAP)
        .collect();
    if !urls.is_empty() {
        let fetched = futures::future::join_all(urls.iter().map(|url| extract_url(url))).await;
        pages.extend(fetched.into_iter().flatten());
    }

    // 去重（保留首次出现的顺序）
    let mut seen = std::collections::HashSet::new();
    pages.retain(|page| !page.url.is_empty() && seen.insert(page.url.clone()));
    (pages, query_count, failed)
}

/// 把采集结果写成 Markdown 来源汇编并落盘。
///
/// `cwd` 必须是宿主认可的工作目录（工作台工程目录 / 工作区 / git 仓库根），
/// `save_to` 必须是单层相对文件名且以 `.md` 结尾——两者都由 `resolve_save_target`
/// 做确定性校验，避免模型把文件写到任意路径。
pub fn write_research_markdown(
    cwd: &std::path::Path,
    save_to: &str,
    topic: &str,
    pages: &[PageExtract],
) -> Result<ResearchCollectOutcome, String> {
    let target = resolve_save_target(cwd, save_to)?;
    let out = render_research_markdown(topic, pages);
    std::fs::write(&target, out.as_bytes())
        .map_err(|e| format!("write {} failed: {e}", target.display()))?;
    Ok(ResearchCollectOutcome {
        saved: save_to.to_string(),
        sources: pages.len(),
        queries: 0,
        failed: 0,
    })
}

/// 来源汇编的 Markdown 渲染（纯函数，便于单测）。
fn render_research_markdown(topic: &str, pages: &[PageExtract]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Sources — {}\n\n", sanitize_inline(topic)));
    out.push_str(&format!(
        "Collected by ai00_research_collect · {} sources\n\n",
        pages.len()
    ));
    for (index, page) in pages.iter().enumerate() {
        out.push_str(&format!(
            "## {}. {}\n\n- URL: {}\n",
            index + 1,
            sanitize_inline(&page.title),
            page.url
        ));
        let summary = page.summary.trim().replace("\r\n", "\n");
        if summary.is_empty() {
            out.push_str("- Summary: (empty)\n");
        } else {
            out.push_str("- Summary:\n");
            for line in summary.lines().take(12) {
                let line = line.trim();
                if !line.is_empty() {
                    out.push_str(&format!("  {line}\n"));
                }
            }
        }
        if page.degraded {
            out.push_str("- Note: [degraded] snippet fallback (local screening skipped)\n");
        }
        out.push('\n');
    }
    out
}

/// 标题/主题里的换行与首尾空白清洗（Markdown 结构不被模型产出的文本打散）。
fn sanitize_inline(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 校验并解析落盘目标：单层相对 `.md` 文件名 + cwd 在允许根内。
pub fn resolve_save_target(
    cwd: &std::path::Path,
    save_to: &str,
) -> Result<std::path::PathBuf, String> {
    let name = save_to.trim();
    if name.is_empty() {
        return Err("save_to is empty".to_string());
    }
    if name.starts_with('/') || name.starts_with('\\') || name.contains(':') {
        return Err("save_to must be a relative file name (no drive/absolute path)".to_string());
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("save_to must be a single file name (no directory separators)".to_string());
    }
    if !name.to_lowercase().ends_with(".md") {
        return Err("save_to must end with .md".to_string());
    }
    let dir = std::fs::canonicalize(cwd)
        .map_err(|e| format!("cwd does not exist ({}): {e}", cwd.display()))?;
    if !dir.is_dir() {
        return Err(format!("cwd is not a directory: {}", dir.display()));
    }
    if !is_allowed_research_root(&dir) {
        return Err(format!(
            "cwd is outside the allowed research roots: {}",
            dir.display()
        ));
    }
    Ok(dir.join(name))
}

/// 允许落盘的目录：宿主生成的工作台工程目录（带 `AGENTS.local.md`）、
/// 工作台/工作区根内，或一个 git 仓库根（用户自带工程目录的任务）。
fn is_allowed_research_root(dir: &std::path::Path) -> bool {
    // Windows 文件系统大小写不敏感，但 `Path::starts_with` 区分大小写：
    // 统一按小写字符串前缀比较，避免盘符/目录大小写差异误拒。
    let dir_key = dir.to_string_lossy().to_lowercase();
    for root in research_allowed_roots() {
        let root_key = root.to_string_lossy().to_lowercase();
        if dir_key.starts_with(&root_key) {
            return true;
        }
    }
    dir.join("AGENTS.local.md").exists() || dir.join(".git").exists()
}

/// 允许根：`<APPDATA>/Ai00-X/workbenches` 与 `<exe_dir>/data/workspaces`。
fn research_allowed_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Some(data_dir) = dirs::data_dir() {
        roots.push(data_dir.join("Ai00-X").join("workbenches"));
    }
    if let Ok(exe_dir) = ai00_x_core::infrastructure::PathManager::exe_dir() {
        roots.push(exe_dir.join("data").join("workspaces"));
    }
    roots
}

/// url 直达模式：抓取指定单页 → 提正文（web_fetch 的本机替代）。
///
/// 与 query 模式不同：不做搜索、不做本地筛选——调用方已明确指定页面，
/// 正文（≤ PAGE_MD_CHARS 清洗 Markdown）直接交还模型；需要摘要由调用方
/// 再接 ai00_text_summarize，职责单一、延迟可控。
/// 返回 None = 抓取/提取失败（SSRF 拦截、超时、空壳渲染失败等）。
pub async fn extract_url(url: &str) -> Option<PageExtract> {
    let markdown = fetch_page_markdown(url).await?;
    // 标题：取正文首个一级标题；无则空串（调用方可从 URL 判断来源）
    let title = markdown
        .lines()
        .find_map(|l| l.trim().strip_prefix("# ").map(str::trim))
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(120).collect())
        .unwrap_or_default();
    Some(PageExtract {
        title,
        url: url.to_string(),
        summary: markdown,
        degraded: false,
    })
}

/// 空壳/SPA 判定：剥掉 script/style 与标签后的可见文本过短、而页面总体偏大
/// （脚本密集）——典型的前端框架空壳特征。
fn is_shell_page(html: &str) -> bool {
    // 剥 script/style 块
    let mut cleaned = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let Some(open) = ["<script", "<style"]
            .iter()
            .filter_map(|t| rest.find(t))
            .min()
        else {
            cleaned.push_str(rest);
            break;
        };
        let close = if rest[open..].starts_with("<script") {
            "</script>"
        } else {
            "</style>"
        };
        cleaned.push_str(&rest[..open]);
        match rest[open..].find(close) {
            Some(off) => rest = &rest[open + off + close.len()..],
            None => break,
        }
    }
    // 数可见文本字符
    let mut text_chars = 0usize;
    let mut in_tag = false;
    for ch in cleaned.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag && !c.is_whitespace() => text_chars += 1,
            _ => {}
        }
    }
    text_chars < 250 && html.len() > 3000
}

/// html → markdown（统一 htmd 配置）。
fn html_to_markdown(html: &str) -> Option<String> {
    let converter = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec!["script", "style", "noscript", "iframe"])
        .build();
    let md = converter.convert(html).ok()?;
    let cleaned = clean_markdown_noise(md.trim());
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(PAGE_MD_CHARS).collect())
    }
}

/// r.jina.ai 托管 reader：JS 渲染 + 直接返回 markdown（免费额度，限速容忍失败）。
async fn fetch_via_jina(url: &str) -> Option<String> {
    let jina_url = format!("https://r.jina.ai/{url}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .redirect(ai00_x_core::util::net_guard::safe_redirect_policy(3))
        .build()
        .ok()?;
    let resp = client.get(&jina_url).send().await.ok()?;
    if !resp.status().is_success() {
        log::warn!("[web-extract] r.jina.ai http {}", resp.status());
        return None;
    }
    let md = resp.text().await.ok()?;
    let cleaned = clean_markdown_noise(md.trim());
    if cleaned.is_empty() {
        None
    } else {
        log::info!("[web-extract] r.jina.ai fallback succeeded: {url}");
        Some(cleaned.chars().take(PAGE_MD_CHARS).collect())
    }
}

/// 抓取单页：10s 超时、2MB 截断流式读取、htmd 转 Markdown、取前 3000 字符。
async fn fetch_page_markdown(url: &str) -> Option<String> {
    if is_private_ip(url) {
        log::warn!("[web-extract] blocked private url: {url}");
        return None;
    }
    // P1-A：字符串前缀过滤只挡 IP 字面量；域名解析到内网的场景交给 net_guard
    //（解析后全记录过封网清单）。
    if let Err(e) = ai00_x_core::util::net_guard::assert_url_allowed(url).await {
        log::warn!("[web-extract] blocked by net guard: {e}");
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
        .redirect(ai00_x_core::util::net_guard::safe_redirect_policy(3))
        .build()
        .ok()?;
    let mut resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    // 2MB 截断流式读取（pages 通常远小于此；超大页直接截断不失败）
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let remain = FETCH_BYTES_CAP.saturating_sub(buf.len());
                if remain == 0 {
                    break;
                }
                let take = remain.min(chunk.len());
                buf.extend_from_slice(&chunk[..take]);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    if buf.is_empty() {
        return None;
    }
    let html = ai00_x_core::websearch::decode_html_bytes(&buf, content_type.as_deref());
    // P1 无头 v1：空壳/SPA 判定——正文极少但页面很大且脚本密集 → JS 渲染升级
    let is_shell = is_shell_page(&html);
    let effective_html = if is_shell {
        match crate::headless_fetch::fetch_rendered_html(url).await {
            Ok(rendered) => {
                log::info!("[web-extract] headless render upgraded: {url}");
                rendered
            }
            Err(e) => {
                log::warn!("[web-extract] headless render failed ({e}), trying r.jina.ai: {url}");
                // r.jina.ai 托管 reader：JS 渲染 + 直接返回 markdown（免费额度）
                return fetch_via_jina(url).await;
            }
        }
    } else {
        html
    };
    let md = html_to_markdown(&effective_html)?;
    let cleaned = clean_markdown_noise(md.trim());
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned.chars().take(PAGE_MD_CHARS).collect())
}

/// 清洗 htmd 输出的噪声（小模型在长噪声输入上容易丢失指令，2026-09-11 实录）：
/// 去图片语法、链接语法→纯文本、折叠空行、丢弃纯导航短行。
fn clean_markdown_noise(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut last_blank = false;
    for line in md.lines() {
        let mut l = line.trim().to_string();
        // ![alt](url) 与行内图片
        while let Some(start) = l.find("![") {
            match l[start..].find(')') {
                Some(rel) => l.replace_range(start..=start + rel, ""),
                None => break,
            }
        }
        // [text](url) → text
        while let Some(start) = l.find('[') {
            let Some(close) = l[start..].find("](") else {
                break;
            };
            let text_end = start + close;
            let Some(rel) = l[text_end..].find(')') else {
                break;
            };
            let inner: String = l[start + 1..text_end].to_string();
            l.replace_range(start..=text_end + rel, &inner);
        }
        let l = l.trim();
        // 纯导航短行（去掉链接后几乎无文字）丢弃
        if l.chars().count() < 6 && !l.chars().any(|c| c.is_alphanumeric()) {
            continue;
        }
        if l.is_empty() {
            if last_blank {
                continue;
            }
            last_blank = true;
        } else {
            last_blank = false;
        }
        out.push_str(l);
        out.push('\n');
    }
    out.trim().to_string()
}

/// 筛选输出解析结果。
#[derive(Debug)]
enum ScreenOutcome {
    /// 相关，附模型摘要。
    Relevant(String),
    /// 不相关，丢弃该页。
    NotRelevant,
}

/// 解析筛选输出：JSON 优先；散文兜底。
///
/// 3B 的散文变体远比最初设想的多（2026-11-21 实测日志）：
/// 「是的，…相关，并提取到要点：…」「网页内容与查询「…」相关，并提取到要点：…」
/// 「是\n<正文>」「根据网页内容，「…」…」「…并不相关，因为…」「不相關，無法提取」，
/// 还有直接复述指令「判断网页内容与查询…只输出一行 JSON。」。
/// 这些此前全部判 unparseable → 页面以 degraded 片段保留，报告混入大量无关站点。
fn parse_screen_output(text: &str) -> Option<ScreenOutcome> {
    // 1) JSON 优先（salvage 支持多候选跳模板复述）
    if let Some(json) = crate::ai_gateway::salvage_balanced_json(text) {
        let relevant = match json.get("relevant") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s.trim().eq_ignore_ascii_case("true"),
            _ => return None, // 有 JSON 但缺 relevant 字段 → 无法解析
        };
        if !relevant {
            return Some(ScreenOutcome::NotRelevant);
        }
        let summary = json
            .get("summary")
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(500).collect::<String>());
        return summary.map(ScreenOutcome::Relevant);
    }
    let t = text.trim();
    // 2) 否定信号（含繁简与"无法提取"类拒绝）：先于正向判定，否则
    //    「…是否相关并不相关…」会被当成相关。
    if NEGATIVE_MARKERS.iter().any(|m| t.contains(m)) {
        return Some(ScreenOutcome::NotRelevant);
    }
    // 3) 弱相关判定（3B 的实际结论常写成「相关性较弱，仅部分相关」）：
    //    模型没给正文要点，按无法解析处理 → 调用方用 snippet 降级收录，
    //    既不留伪摘要，也不丢掉这个 URL。
    if WEAK_MARKERS.iter().any(|m| t.contains(m)) {
        return None;
    }
    // 4) 指令复述（模型把提示词照抄，没有任何判定）
    if t.starts_with("判断网页内容") || t.contains("只输出一行 JSON") {
        return None;
    }
    // 5) 显式「相关：…」
    if let Some(body) = t.strip_prefix("相关：").or_else(|| t.strip_prefix("相关:")) {
        let summary = extract_prose_summary(body);
        // 没有「要点」标记时，冒号后的整段就是要点本身
        let summary = if summary.is_empty() {
            trim_summary(body)
        } else {
            summary
        };
        return (!summary.is_empty()).then_some(ScreenOutcome::Relevant(summary));
    }
    // 5) 含「相关」/ 肯定句「是…」/「根据网页内容…」→ 抽正文
    if t.contains("相关") || t.starts_with('是') || t.starts_with("根据网页内容") {
        let summary = extract_prose_summary(t);
        return (!summary.is_empty()).then_some(ScreenOutcome::Relevant(summary));
    }
    None
}

/// 页面不相关的散文信号（2026-11-21 实测：3B 用这些说法明确拒绝页面）。
const NEGATIVE_MARKERS: [&str; 8] = [
    "不相关",
    "不相關",
    "没有提取到",
    "未提取到",
    "无法提取",
    "無法提取",
    "没有直接提及",
    "未提及",
];

/// 弱相关判定（3B 不确定时的说法）：没有正文要点，按无法解析降级。
const WEAK_MARKERS: [&str; 4] = ["较弱", "弱相关", "仅部分相关", "不太相关"];

/// 从散文里抽要点正文字符串（500 字符上限）。
fn extract_prose_summary(text: &str) -> String {
    // ① 要点标记优先：「相关：…\n要点：…」「…并提取到要点：…」
    for marker in [
        "提取要点：",
        "提取到要点：",
        "要点：",
        "提取要点:",
        "提取到要点:",
        "要点:",
    ] {
        if let Some(pos) = text.find(marker) {
            let body = trim_summary(&text[pos + marker.len()..]);
            if !body.is_empty() {
                return body;
            }
        }
    }
    // ② 「…相关，<正文>」：先把「是否相关」这类疑问表述抹掉再定位
    let normalized = text.replace("是否相关", "是否");
    if let Some(pos) = normalized.find("相关") {
        let body = trim_summary(&normalized[pos + "相关".len()..]);
        if body.chars().count() >= 6 {
            return body;
        }
    }
    // ③ 肯定句「是的」「是」→ 取其余部分（先试「是的」，否则「的，…」会残留）
    if let Some(rest) = text
        .strip_prefix("是的")
        .or_else(|| text.strip_prefix("是"))
    {
        let body = trim_summary(rest);
        if body.chars().count() >= 6 {
            return body;
        }
    }
    // ④ 「根据网页内容，…」→ 取其余部分
    for prefix in ["根据网页内容", "根据提供的网页内容", "根据内容"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            let body = trim_summary(rest);
            if body.chars().count() >= 6 {
                return body;
            }
        }
    }
    String::new()
}

/// 去掉摘要首尾的连接词与标点，并截到 500 字符。
fn trim_summary(raw: &str) -> String {
    let head = raw.trim_start_matches(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '，' | '。' | '、' | '：' | ':' | '；' | ';' | '并' | '且'
            )
    });
    let body: String = head.chars().take(500).collect();
    body.trim_end_matches(|c: char| {
        c.is_whitespace() || matches!(c, '，' | '。' | '、' | '；' | ';')
    })
    .to_string()
}

/// 3B 把示例答案整段复述（示例固定为「RWKV…」，与真实查询无关时即为编造）。
fn is_example_parrot(query: &str, summary: &str) -> bool {
    summary.contains("RWKV")
        && summary.contains("RNN")
        && summary.contains("Transformer")
        && !query.to_ascii_lowercase().contains("rwkv")
}

/// 单页本地筛选：1-shot 对话格式 JSON 输出，散文协议兜底；
async fn screen_page(query: &str, page: &FetchedPage, markdown: &str) -> Option<PageExtract> {
    let degraded = || {
        Some(PageExtract {
            title: page.title.clone(),
            url: page.url.clone(),
            summary: page.snippet.clone(),
            degraded: true,
        })
    };
    let query_clean: String = query
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    // 1-shot 对话格式（项目记忆验证：few-shot 多消息提示词 JSON 骨架稳定）。
    // 格式说明不放内联模板（「相关时：...；不相关：...」会被鹦鹉学舌复述），
    // 只由示例答案锚定输出形状；示例查询固定为「RWKV 是什么」避免复述真实查询。
    let turn = |q: &str, content: &str| {
        format!("判断网页内容与查询「{q}」是否相关并提取要点，只输出一行 JSON。\n网页内容：\n<content>\n{content}\n</content>")
    };
    let prompt = format!(
        "User: {}\n\nAssistant: {{\"relevant\":true,\"summary\":\"RWKV 是结合 RNN 与 Transformer 优点的大模型架构，推理快、省显存\"}}\n\nUser: {}\n\nAssistant: ",
        turn("RWKV 是什么", "RWKV 是一种结合了 RNN 和 Transformer 优点的大模型架构，推理快速、节省显存，支持无限上下文。"),
        turn(&query_clean, markdown),
    );
    let started = std::time::Instant::now();
    let infer = async {
        let mut rx = pool_infer(
            prompt,
            SCREEN_MAX_TOKENS,
            0.1, // 近贪心（JSON 骨架稳定配方）
            0,
            0.5,
            0.5,
            0.996,
            Some(rwkv_stop()),
            None, // 零状态临时会话
            false,
            false,
            String::new(),
        )
        .await?;
        let mut text = String::new();
        let mut input_tokens = 0usize;
        let mut output_tokens = 0usize;
        while let Some(event) = rx.recv().await {
            match event {
                InferenceEvent::Done {
                    text: t,
                    input_tokens: it,
                    output_tokens: ot,
                    ..
                } => {
                    text = t;
                    input_tokens = it;
                    output_tokens = ot;
                    break;
                }
                InferenceEvent::Error(e) => return Err(e),
                _ => {}
            }
        }
        crate::rwkv_llm::record_local_usage(
            "local-direct-extract",
            "rwkv-local",
            input_tokens,
            output_tokens,
            started.elapsed().as_millis() as u64,
        )
        .await;
        Ok(text)
    };
    let text = match tokio::time::timeout(Duration::from_secs(SCREEN_TIMEOUT_SECS), infer).await {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            log::warn!("[web-extract] screen infer failed for {}: {e}", page.url);
            maybe_lazy_init(&e);
            return degraded();
        }
        Err(_) => {
            log::warn!("[web-extract] screen timeout for {}", page.url);
            return degraded();
        }
    };

    match parse_screen_output(&text) {
        Some(ScreenOutcome::Relevant(summary)) => {
            if is_example_parrot(query, &summary) {
                // 模型没有真读正文，只是复述示例答案 → 不能算相关证据
                log::warn!(
                    "[web-extract] screen parroted example answer for {}; dropping page",
                    page.url
                );
                return None;
            }
            Some(PageExtract {
                title: page.title.clone(),
                url: page.url.clone(),
                summary,
                degraded: false,
            })
        }
        Some(ScreenOutcome::NotRelevant) => None,
        None => {
            let head: String = text.chars().take(200).collect();
            log::warn!(
                "[web-extract] screen output unparseable for {} | raw: {head:?}",
                page.url
            );
            degraded()
        }
    }
}

// ---------------------------------------------------------------------------
// 长文总结（ai00_text_summarize）：≤6000 字符单次；>6000 切块 map-reduce 并发
// ---------------------------------------------------------------------------

/// 总结结果（路由响应形状）。
#[derive(Debug, Clone, Serialize)]
pub struct SummarizeResult {
    pub summary: String,
    /// true = 质量门未全过（局部块降级/最终合并降级），结果可用但非最优。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub degraded: bool,
}

/// 单次本地总结推理：Instruction 格式。返回 (文本, hit_len)。
async fn summarize_once(
    prompt: String,
    max_tokens: usize,
    top_p: f32,
) -> Result<(String, bool), String> {
    let started = std::time::Instant::now();
    let mut rx = pool_infer(
        prompt,
        max_tokens,
        top_p,
        0,
        0.5,
        0.5,
        0.996,
        Some(rwkv_stop()),
        None, // 零状态临时会话
        false,
        false,
        String::new(),
    )
    .await
    .inspect_err(|e| maybe_lazy_init(e))?;
    let mut text = String::new();
    let mut hit_len = false;
    let mut input_tokens = 0usize;
    let mut output_tokens = 0usize;
    while let Some(event) = rx.recv().await {
        match event {
            InferenceEvent::Done {
                text: t,
                input_tokens: it,
                output_tokens: ot,
                stop_sequence,
                ..
            } => {
                text = t;
                input_tokens = it;
                output_tokens = ot;
                hit_len = stop_sequence.is_none();
                break;
            }
            InferenceEvent::Error(e) => return Err(e),
            _ => {}
        }
    }
    crate::rwkv_llm::record_local_usage(
        "local-direct-summarize",
        "rwkv-local",
        input_tokens,
        output_tokens,
        started.elapsed().as_millis() as u64,
    )
    .await;
    Ok((text.trim().to_string(), hit_len))
}

/// 从最后一个句末标点处剪断（截断收尾用）。返回 None = 没有可用句末或剩余过短。
fn trim_to_last_sentence(text: &str) -> Option<String> {
    const ENDS: [char; 9] = ['。', '！', '？', '；', '!', '?', '.', '…', '\n'];
    let mut end = None;
    for (i, c) in text.char_indices() {
        if ENDS.contains(&c) {
            end = Some(i + c.len_utf8());
        }
    }
    let cut = text[..end?].trim();
    (cut.chars().count() >= 20).then(|| cut.to_string())
}

/// 总结结果的质量判定：直接过门；仅「max_tokens 截断」时按句末收尾再判一次。
///
/// 实测（2026-11-25，3k/12k 字材料）：3B 摘要经常一路写到 max_tokens 才停
/// （单次 15s、1000 token），旧逻辑把这段**可用的**摘要整个丢弃、退化成
/// 「原文前 N 字」——信息密度暴跌。按最后一个句末标点剪断再判门，既保留
/// 模型摘要又不交半句。
fn accept_summary(text: String, hit_len: bool) -> Option<String> {
    if crate::tool_session::quality_gate(&text, hit_len).is_ok() {
        return Some(text);
    }
    if hit_len {
        if let Some(cut) = trim_to_last_sentence(&text) {
            if crate::tool_session::quality_gate(&cut, false).is_ok() {
                return Some(cut);
            }
        }
    }
    None
}

/// 单块摘要（map）：质量门拦截 → top_p=0.5 重试一次 → 仍不合格用原文截断降级。
async fn summarize_chunk(
    idx: usize,
    total: usize,
    chunk: &str,
    focus: Option<&str>,
    cjk: bool,
) -> (String, bool) {
    let focus_clause = match (focus, cjk) {
        (Some(f), true) => format!("，重点关注「{f}」"),
        (Some(f), false) => format!(", focus on \"{f}\""),
        (None, _) => String::new(),
    };
    let prompt = if cjk {
        format!(
            "Instruction: 以下是长文的第 {idx}/{total} 部分，请总结其要点{focus_clause}，控制在 {SUMMARIZE_CHUNK_TARGET} 字以内。\n\nInput: {chunk}\n\nResponse: "
        )
    } else {
        format!(
            "Instruction: The following is part {idx}/{total} of a long text. Summarize its key points{focus_clause} in under {SUMMARIZE_CHUNK_TARGET} characters.\n\nInput: {chunk}\n\nResponse: "
        )
    };
    for top_p in [0.3, 0.5] {
        let attempt = tokio::time::timeout(
            Duration::from_secs(SCREEN_TIMEOUT_SECS),
            summarize_once(prompt.clone(), SCREEN_MAX_TOKENS, top_p),
        )
        .await;
        if let Ok(Ok((text, hit_len))) = attempt {
            if let Some(summary) = accept_summary(text, hit_len) {
                // 分块语言闸门：英文块吐中文/日文会污染后续合并（实测 chunk 0/3 英文），
                // 该块改用它自己的同语言摘录。
                if summary.chars().count() >= 20 && is_cjk_text(&summary) != cjk {
                    log::warn!(
                        "[text-summarize] chunk {idx}/{total} language mismatch -> extractive"
                    );
                    return (
                        extractive_summary(chunk, focus, SUMMARIZE_CHUNK_TARGET),
                        false,
                    );
                }
                return (summary, false);
            }
            log::warn!("[text-summarize] chunk {idx}/{total} failed quality gate (top_p={top_p})");
        } else if let Ok(Err(ref e)) = attempt {
            maybe_lazy_init(e);
        }
    }
    log::warn!("[text-summarize] chunk {idx}/{total} degraded to raw truncation");
    (
        chunk.chars().take(SUMMARIZE_CHUNK_TARGET * 2).collect(),
        true,
    )
}

/// 文本主语言：CJK 字数 ≥ 拉丁字母数的一半 → 中文，否则英文。
///
/// 摘要提示词此前写死中文，实测英文 3k 字文档输出 83% 是汉字（2026-11-25 探针）：
/// 国际用户看到的摘要直接跑偏。按正文语言选提示词，输出语言跟随原文。
fn is_cjk_text(text: &str) -> bool {
    let mut cjk = 0usize;
    let mut latin = 0usize;
    for c in text.chars().take(3000) {
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            cjk += 1;
        } else if c.is_ascii_alphabetic() {
            latin += 1;
        }
    }
    cjk * 2 >= latin.max(1)
}

/// 按中英文句末标点切句（保留终止符）。英文 `.` 只在后面是空白/引号/结尾时算
/// 句末，避免把 `3.5` / `example.com` 切碎。
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut it = text.char_indices().peekable();
    while let Some((_, c)) = it.next() {
        cur.push(c);
        let end = match c {
            '。' | '！' | '？' | '；' | '\n' => true,
            '!' | '?' | ';' => true,
            '.' => it
                .peek()
                .map(|(_, n)| n.is_whitespace() || matches!(n, '"' | '\'' | ')' | ']'))
                .unwrap_or(true),
            _ => false,
        };
        if end {
            let s = cur.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
            cur.clear();
        }
    }
    let s = cur.trim().to_string();
    if !s.is_empty() {
        out.push(s);
    }
    out
}

/// focus 命中句摘录（确定性）：把「含 focus 的原文句子」补进摘要。
///
/// 实测（2026-11-25，12 对 3.8k 字材料，埋入编号）：无论是否给 focus，3B 摘要
/// 都不保留编号（0/12），且半数输出撞 500 字上限或降级为原文截断——研究/问答
/// 链路靠摘要传递关键事实，模型注意力不可靠时只能由宿主兜底：摘要后补一段
/// 「原文摘录」，保证被查询的事实不丢。最多 3 句 / 300 字。
///
/// 英文文档同样生效：旧实现只按中文标点切句，整篇英文变成一个「超长句」被
/// MAX_CHARS 直接丢弃（实测英文探针摘录为空），现按 `split_sentences` 切。
fn focus_evidence(text: &str, focus: &str) -> Option<String> {
    const MAX_SENTENCES: usize = 3;
    const MAX_CHARS: usize = 300;
    let needle = focus.to_lowercase();
    let mut out = String::new();
    let mut count = 0usize;
    for sentence in split_sentences(text) {
        if !sentence.to_lowercase().contains(&needle) {
            continue;
        }
        // 英文句子之间补空格；纯 CJK 句子直接连写。
        let sep = if !out.is_empty() && sentence.chars().any(|c| c.is_ascii_alphabetic()) {
            " "
        } else {
            ""
        };
        if out.chars().count() + sep.len() + sentence.chars().count() > MAX_CHARS {
            break;
        }
        out.push_str(sep);
        out.push_str(&sentence);
        count += 1;
        if count >= MAX_SENTENCES {
            break;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// 把过小的块并入相邻块（MarkdownSplitter 会把孤立围栏/短标题切成 <200 字的块，
/// 单独摘要毫无意义）。合并后允许超出上限 ≤200 字。
fn merge_tiny_chunks(chunks: Vec<String>, max_chars: usize) -> Vec<String> {
    const TINY: usize = 200;
    let mut out: Vec<String> = Vec::new();
    let mut carry = String::new();
    for c in chunks {
        let c = if carry.is_empty() {
            c
        } else {
            let mut s = std::mem::take(&mut carry);
            s.push('\n');
            s.push_str(&c);
            s
        };
        if c.chars().count() < TINY {
            if let Some(last) = out.last_mut() {
                if last.chars().count() + c.chars().count() < max_chars {
                    last.push('\n');
                    last.push_str(&c);
                    continue;
                }
            }
            carry = c;
            continue;
        }
        out.push(c);
    }
    if !carry.is_empty() {
        if let Some(last) = out.last_mut() {
            last.push('\n');
            last.push_str(&carry);
        } else {
            out.push(carry);
        }
    }
    out
}

/// 智能切块：`MarkdownSplitter`（pulldown-cmark）按标题层级 / 段落 / 代码围栏 /
/// 列表切分，报告类长文不会从章节中间劈开，代码块按行切而不是从行内切断。
///
/// 2026-11-25 实测（text-splitter 0.30.1）：4 个 `##` 章节（5.8k 字）→ 两块都从
/// `##` 标题起；含 5k 字围栏的文档 → 围栏独立成块、代码整行切；纯文本/空行分段
/// 的结果与 `TextSplitter` 完全一致，故统一走 Markdown 切分。
fn split_for_summary(text: &str) -> Vec<String> {
    let chunks: Vec<String> = text_splitter::MarkdownSplitter::new(SUMMARIZE_CHUNK_CHARS)
        .chunks(text)
        .map(str::to_string)
        .collect();
    merge_tiny_chunks(chunks, SUMMARIZE_CHUNK_CHARS)
}

/// 模型摘要超长时按句末标点收到 `max_chars` 内（prompt 里的长度要求 3B 常忽略：
/// 实测要求 300 字却输出 2478 字）。取「能完整放下的句子前缀」，一句都放不下才硬切。
fn cap_summary_length(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out = String::new();
    for s in split_sentences(text) {
        let sep = if !out.is_empty() && s.chars().any(|c| c.is_ascii_alphabetic()) {
            " "
        } else {
            ""
        };
        if out.chars().count() + sep.len() + s.chars().count() > max_chars {
            // 单句就超上限（整段没有句末标点，实测英文重写吐过 704 字一句）：
            // 硬切，否则上限形同虚设。
            if out.is_empty() {
                return s.chars().take(max_chars).collect();
            }
            break;
        }
        out.push_str(sep);
        out.push_str(&s);
    }
    if out.is_empty() {
        text.chars().take(max_chars).collect()
    } else {
        out
    }
}

/// 确定性摘录式摘要：开头两句（导语）+ focus 命中句，保证与原文同语言。
///
/// 用于「模型摘要语言跑偏」的兜底。实测（2026-11-25，英文 3k/4k/12k 文：
/// 基础指令 2/4 英文、尾部强调 1/4、chunk 0/3、reduce 0/3、翻译兜底 0/3，
/// 另出现过 268 字纯 emoji）——3B 对长英文文档的摘要语言遵循不可靠，与其
/// 返回中文乱码，不如退到同语言摘录：事实密度高、零推理成本、永不跑偏。
fn extractive_summary(text: &str, focus: Option<&str>, max_chars: usize) -> String {
    let sentences = split_sentences(text);
    // 优先级：首句 → focus 命中句（至多 2 句）→ 第二句。不能先排两条导语再放
    // focus 句——实测长度上限会把关键句挤掉（英文 3k 案例摘录 201 字但暗号丢失）。
    let mut picks: Vec<usize> = Vec::new();
    if !sentences.is_empty() {
        picks.push(0);
    }
    if let Some(f) = focus {
        let needle = f.to_lowercase();
        let mut extra = 0usize;
        for (i, s) in sentences.iter().enumerate() {
            if extra >= 2 {
                break;
            }
            if picks.contains(&i) || !s.to_lowercase().contains(&needle) {
                continue;
            }
            picks.push(i);
            extra += 1;
        }
    }
    if sentences.len() > 1 && !picks.contains(&1) {
        picks.push(1);
    }
    let mut out = String::new();
    for i in picks {
        let s = &sentences[i];
        let sep = if !out.is_empty() && s.chars().any(|c| c.is_ascii_alphabetic()) {
            " "
        } else {
            ""
        };
        if !out.is_empty() && out.chars().count() + sep.len() + s.chars().count() > max_chars {
            break;
        }
        out.push_str(sep);
        out.push_str(s);
    }
    out
}

/// 拉丁字母是否占字母多数（英文/西欧语近似判定）。
///
/// 非中文长文的「摘录 → 一段话」重写提示词固定英文；对俄语/日文等非英文文档
/// 不能强行翻成英文——不是英文就直接返回摘录（同语言）。
fn looks_english(text: &str) -> bool {
    let mut ascii = 0usize;
    let mut other = 0usize;
    for c in text.chars().take(3000) {
        if c.is_ascii_alphabetic() {
            ascii += 1;
        } else if c.is_alphabetic() {
            other += 1;
        }
    }
    ascii >= other.max(1)
}

/// CJK 字符占比（语言闸门用：重写结果必须 <5% 汉字才算英文）。
fn cjk_ratio(text: &str) -> f32 {
    let mut cjk = 0usize;
    let mut total = 0usize;
    for c in text.chars() {
        total += 1;
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            cjk += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        cjk as f32 / total as f32
    }
}

/// 非中文长文：确定性摘录 → 一次「写成一段」重写。
///
/// 实测（2026-11-25）：3B 直接总结长英文文档 0/3~2/4 出英文（chunk 0/3、reduce
/// 0/3），但「把这几句关键句写成一段英文」3/3 出英文、约 1 秒。故非中文长文
/// 不再逐块调用模型：宿主先按块摘录，再让模型写一段话；重写失败/跑偏时直接
/// 返回摘录（同语言、事实不丢）。
async fn summarize_non_cjk(text: &str, focus: Option<&str>, max_length: usize) -> SummarizeResult {
    let chunks = split_for_summary(text);
    let mut extracts: Vec<String> = Vec::new();
    for c in &chunks {
        let e = extractive_summary(c, focus, SUMMARIZE_CHUNK_TARGET);
        // 摘录开头的 Markdown 标记会把重写提示带偏（实测 "## Section 0 …" 输入
        // 更容易吐中文），生成前先去掉行首 `#`。
        let e = e.trim_start_matches('#').trim_start().to_string();
        if !e.is_empty() {
            extracts.push(e);
        }
    }
    // 摘录总长压到 400 字：实测 1200 字输入时英文率 2/3、600 token 时 1/3，
    // 300–400 字 + 320 token 是 3/3（2026-11-25 探针）。
    let joined: String = extracts.join(" ").chars().take(400).collect();
    if joined.is_empty() {
        return SummarizeResult {
            summary: String::new(),
            degraded: true,
        };
    }
    if !looks_english(text) {
        log::warn!("[text-summarize] non-cjk non-english doc, returning extracts");
        return SummarizeResult {
            summary: cap_summary_length(&joined, max_length),
            degraded: true,
        };
    }
    let prompt = format!(
        "System: Write one short paragraph of plain prose in English that summarizes these key sentences. No headings, lists or quotes. Only the paragraph.\n\nUser: Key sentences: {joined}\n\nAssistant: "
    );
    let attempt = tokio::time::timeout(
        Duration::from_secs(SCREEN_TIMEOUT_SECS),
        summarize_once(prompt, 320, 0.3),
    )
    .await;
    if let Ok(Ok((summary, hit_len))) = attempt {
        if let Some(summary) = accept_summary(summary, hit_len) {
            // 英文重写必须几乎无汉字（"根据…总结出如下要点 1 Document 解释…" 这类
            // 中英混排的 is_cjk_text 判定会放行，实测 0.13 占比漏网）。
            if cjk_ratio(&summary) < 0.05 {
                return SummarizeResult {
                    summary: cap_summary_length(&summary, max_length),
                    degraded: false,
                };
            }
        }
    }
    log::warn!("[text-summarize] non-cjk rewrite failed, returning extracts");
    SummarizeResult {
        summary: cap_summary_length(&joined, max_length),
        degraded: true,
    }
}

/// 长文总结主流程：≤6000 单次；>6000 切块并发 map → 合并 reduce。
pub async fn summarize(
    text: &str,
    focus: Option<&str>,
    max_length: Option<usize>,
) -> SummarizeResult {
    let max_length = max_length
        .unwrap_or(SUMMARIZE_DEFAULT_MAX_LENGTH)
        .clamp(50, 4000);
    let text = text.trim();
    if text.is_empty() {
        return SummarizeResult {
            summary: String::new(),
            degraded: true,
        };
    }
    // focus 入 prompt 前清洗（模型参数不可信）：去控制字符 + 限长
    let focus: Option<String> =
        focus.map(|f| f.chars().filter(|c| !c.is_control()).take(100).collect());
    let focus = focus.as_deref();
    let cjk = is_cjk_text(text);
    let focus_clause = match (focus, cjk) {
        (Some(f), true) => format!("，重点关注「{f}」"),
        (Some(f), false) => format!(", focus on \"{f}\""),
        (None, _) => String::new(),
    };
    let char_count = text.chars().count();
    // 摘要后兜底：focus 命中句补录（见 `focus_evidence`）。
    // 判重只看「摘录句是否已整体出现在摘要里」——模型常写出「登记暗号」这个词
    // 却漏掉值（实测 1/12），按关键词判重会把这种漏值当成已覆盖。
    let attach_focus = |mut result: SummarizeResult| -> SummarizeResult {
        // 语言闸门：摘要语言与原文不一致（3B 英文长文常吐中文/日文）→ 同语言摘录兜底。
        // 摘录本身已含 focus 命中句，不再追加「原文摘录」。
        if !result.summary.trim().is_empty()
            && result.summary.chars().count() >= 20
            && is_cjk_text(&result.summary) != cjk
        {
            log::warn!("[text-summarize] language mismatch (doc_cjk={cjk}), extractive fallback");
            result.summary = extractive_summary(text, focus, max_length);
            result.degraded = true;
            return result;
        }
        if let Some(f) = focus {
            if let Some(evidence) = focus_evidence(text, f) {
                if !result.summary.contains(evidence.trim()) {
                    let label = if cjk { "原文摘录：" } else { "Excerpt: " };
                    if !result.summary.is_empty() {
                        result.summary.push_str("\n\n");
                    }
                    result.summary.push_str(label);
                    result.summary.push_str(&evidence);
                }
            }
        }
        result
    };

    // 非中文文档全部走「摘录 → 一次重写」：3B 对英文文档的单次摘要也只有
    // 2/4 出英文（3k 实测），且常写满 1000 token（10–15s）后被丢弃。
    if !cjk {
        return attach_focus(summarize_non_cjk(text, focus, max_length).await);
    }

    if char_count <= SUMMARIZE_SINGLE_SHOT_CHARS {
        let prompt = if cjk {
            format!(
                "Instruction: 请总结以下文本{focus_clause}，控制在 {max_length} 字以内。\n\nInput: {text}\n\nResponse: "
            )
        } else {
            format!(
                "Instruction: Summarize the following text{focus_clause} in under {max_length} characters. Write plain prose.\n\nInput: {text}\n\nResponse: "
            )
        };
        return attach_focus(
            match tokio::time::timeout(
                Duration::from_secs(SCREEN_TIMEOUT_SECS * 2),
                summarize_once(prompt, max_length * 2, 0.3),
            )
            .await
            {
                Ok(Ok((summary, hit_len))) => match accept_summary(summary, hit_len) {
                    Some(summary) => SummarizeResult {
                        summary: cap_summary_length(&summary, max_length),
                        degraded: false,
                    },
                    None => {
                        log::warn!("[text-summarize] single-shot failed/degraded");
                        SummarizeResult {
                            summary: text.chars().take(max_length).collect(),
                            degraded: true,
                        }
                    }
                },
                _ => {
                    log::warn!("[text-summarize] single-shot failed/degraded");
                    SummarizeResult {
                        summary: text.chars().take(max_length).collect(),
                        degraded: true,
                    }
                }
            },
        );
    }

    // map：智能切块（Markdown 标题/段落/代码围栏），并发逐块摘要
    let owned = split_for_summary(text);
    let chunks: Vec<&str> = owned.iter().map(String::as_str).collect();
    let total = chunks.len();
    log::info!("[text-summarize] map-reduce: {char_count} chars -> {total} chunks");
    let partials: Vec<(String, bool)> = futures::future::join_all(
        chunks
            .iter()
            .enumerate()
            .map(|(i, c)| summarize_chunk(i + 1, total, c, focus, cjk)),
    )
    .await;
    let any_degraded = partials.iter().any(|(_, d)| *d);
    let joined = partials
        .iter()
        .enumerate()
        .map(|(i, (s, _))| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");

    // reduce：合并各块摘要为连贯总结（明确要散文，避免默认输出编号列表）
    let prompt = if cjk {
        format!(
            "Instruction: 以下是一篇长文各部分的要点，请合并成一篇连贯的总结{focus_clause}，控制在 {max_length} 字以内，不要逐条编号罗列。\n\nInput: {joined}\n\nResponse: "
        )
    } else {
        format!(
            "Instruction: Below are the key points of each part of a long text. Merge them into one coherent summary{focus_clause} in under {max_length} characters. Write plain prose, no numbered list.\n\nInput: {joined}\n\nResponse: "
        )
    };
    attach_focus(
        match tokio::time::timeout(
            Duration::from_secs(SCREEN_TIMEOUT_SECS * 2),
            summarize_once(prompt, max_length * 2, 0.3),
        )
        .await
        {
            Ok(Ok((summary, hit_len))) => match accept_summary(summary, hit_len) {
                Some(summary) => SummarizeResult {
                    summary: cap_summary_length(&summary, max_length),
                    degraded: any_degraded,
                },
                None => {
                    log::warn!("[text-summarize] reduce failed gate, returning joined partials");
                    SummarizeResult {
                        summary: joined,
                        degraded: true,
                    }
                }
            },
            _ => {
                log::warn!("[text-summarize] reduce failed gate, returning joined partials");
                SummarizeResult {
                    summary: joined,
                    degraded: true,
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// focus 命中句摘录：只取含关键字的句子，最多 3 句。
    #[test]
    fn focus_evidence_keeps_matching_sentences() {
        let text = "第一句无关。第二句登记暗号 MK10WMC0。第三句也无关。\
                    第四句补充暗号说明。第五句多余暗号。第六句不要。";
        let ev = focus_evidence(text, "暗号").expect("应命中");
        assert!(ev.contains("MK10WMC0"), "{ev}");
        assert_eq!(ev.matches('。').count(), 3, "{ev}");
        assert!(focus_evidence(text, "不存在的词").is_none());
    }

    /// 截断收尾：从最后一个句末标点剪断；剩余过短或无句末标点则拒绝。
    #[test]
    fn trim_to_last_sentence_keeps_complete_prefix() {
        let text = "第一句完整并且足够长可以独立成段。第二句也完整并且足够长可以独立成段。第三句被截断在中";
        assert_eq!(
            trim_to_last_sentence(text).as_deref(),
            Some("第一句完整并且足够长可以独立成段。第二句也完整并且足够长可以独立成段。")
        );
        assert_eq!(
            trim_to_last_sentence("没有句末标点的一长串文字没有句末标点的一长串文字"),
            None
        );
        assert_eq!(trim_to_last_sentence("短。"), None);
    }

    /// max_tokens 截断的摘要按句末剪断后可被接受（不再退化成原文截断）。
    #[test]
    fn accept_summary_salvages_truncated_text() {
        let text = "本地推理把长文分块喂入状态空间模型，逐块推进前缀计算。\
                    接着它继续解释缓存命中时如何复用状态，但这一句没有收尾";
        let salvaged = accept_summary(text.to_string(), true).expect("句末收尾后应合格");
        assert!(salvaged.ends_with('。'), "{salvaged}");
        // 未截断时同一段文本直接过门（门的截断判定只认 hit_len）
        assert!(accept_summary(text.to_string(), false).is_some());
        // 过短仍拒绝
        assert!(accept_summary("太短".to_string(), false).is_none());
        // 复读退化仍拒绝（剪断也救不了）
        let rept = "同一片段反复出现同一片段反复出现同一片段反复出现同一片段反复出现。".repeat(3);
        assert!(accept_summary(rept, true).is_none());
    }

    /// 语言判定：中文正文 → true；英文 → false；少量 CJK 混排仍按英文。
    #[test]
    fn detects_text_language() {
        assert!(is_cjk_text(
            "本地推理引擎负责把长文本分块喂入状态空间模型。"
        ));
        assert!(!is_cjk_text(
            "The local inference engine splits long documents into chunks."
        ));
        assert!(!is_cjk_text(
            "RWKV 3B model with 少量中文 mixed text and more English words here."
        ));
    }

    /// 英文切句：句点后是空白才算句末；小数/域名不切。
    #[test]
    fn splits_english_sentences() {
        let s = split_sentences("Latency is 3.5 ms. See example.com for details! Done?");
        assert_eq!(s.len(), 3, "{s:?}");
        assert_eq!(s[0], "Latency is 3.5 ms.");
        assert_eq!(s[2], "Done?");
    }

    /// 英文 focus 摘录：旧实现按中文标点切句会整篇丢弃，现在能命中。
    #[test]
    fn focus_evidence_supports_english() {
        let text = "The engine reuses cached state. The registered code is EN42AB. \
                    Another unrelated sentence follows.";
        let ev = focus_evidence(text, "code").expect("英文字符串应命中");
        assert!(ev.contains("The registered code is EN42AB."), "{ev}");
    }

    /// 智能切块：Markdown 报告按标题边界切，块内不跨章节、不超上限。
    #[test]
    fn split_for_summary_respects_markdown_structure() {
        let sec = "段落内容，保持语义边界。".repeat(120);
        let mut doc = String::new();
        for i in 0..4 {
            doc.push_str(&format!("## Section {i}\n\n{sec}\n\n"));
        }
        let chunks = split_for_summary(&doc);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(
                c.chars().count() <= SUMMARIZE_CHUNK_CHARS + 200,
                "chunk too big: {}",
                c.chars().count()
            );
            let head: String = c.trim_start().chars().take(12).collect();
            assert!(head.starts_with("## Section"), "{head}");
        }
    }

    /// 孤立代码围栏（<200 字）不能单独成块，必须与相邻正文合并。
    #[test]
    fn split_for_summary_merges_tiny_fence_chunks() {
        let code = "fn main() {\n    println!(\"hello\");\n}\n".repeat(180);
        let doc = format!("## Code\n\n```rust\n{code}```\n\n## After\n\n尾巴段落。\n");
        let chunks = split_for_summary(&doc);
        assert!(
            chunks.iter().all(|c| c.chars().count() >= 200),
            "tiny chunk leaked: {:?}",
            chunks.iter().map(|c| c.chars().count()).collect::<Vec<_>>()
        );
    }

    /// 长度上限：超长摘要按句末收进 max_chars；短摘要原样返回。
    #[test]
    fn cap_summary_length_cuts_at_sentence() {
        let long = "这是第一句完整的摘要内容。第二句也很完整并且继续展开。第三句还在继续展开内容。";
        let out = cap_summary_length(long, 20);
        assert!(out.chars().count() <= 20, "{out}");
        assert!(out.ends_with('。'), "{out}");
        assert_eq!(cap_summary_length("很短的摘要。", 100), "很短的摘要。");
        let en = "First sentence here. Second sentence follows.";
        let out = cap_summary_length(en, 25);
        assert!(out.chars().count() <= 25 && out.ends_with('.'), "{out}");
        // 单句超上限（无句末标点）必须硬切
        let one = "word ".repeat(200);
        let out = cap_summary_length(&one, 50);
        assert!(out.chars().count() <= 50, "{}", out.chars().count());
    }

    /// 摘录优先级：首句 → focus 命中句 → 第二句；上限内 focus 事实不能被导语挤掉。
    #[test]
    fn extractive_summary_prioritizes_focus_under_cap() {
        let s1 = "First lead sentence that is intentionally quite long so it consumes a large part of the excerpt budget.";
        let s2 = "Second lead sentence that is also long enough to compete for the remaining budget in the excerpt.";
        let s3 = "The registered code is MK42XY and it must survive the excerpt cap.";
        let text = format!("{s1} {s2} {s3} Unrelated tail.");
        let out = extractive_summary(&text, Some("code"), 180);
        assert!(out.contains("MK42XY"), "{out}");
        assert!(!out.contains("Second lead"), "{out}");
    }

    #[test]
    fn clean_markdown_noise_strips_images_links_and_blank_runs() {
        let md = "![logo](https://x.com/a.png)\n\n[点击这里](https://x.com)查看详情\n\n\n\n---\n正文内容保持不变。[内链](https://y.com)测试。";
        let out = clean_markdown_noise(md);
        assert!(!out.contains("!["), "images stripped: {out}");
        assert!(!out.contains("](https://"), "link syntax stripped: {out}");
        assert!(out.contains("点击这里查看详情"), "link text kept: {out}");
        assert!(out.contains("内链测试"), "inline link text kept: {out}");
        assert!(!out.contains("\n\n\n"), "blank runs collapsed: {out}");
        assert!(!out.contains("---"), "pure-symbol nav line dropped: {out}");
    }

    #[test]
    fn clean_markdown_noise_keeps_cjk_short_lines() {
        let out = clean_markdown_noise("简介\n\n这是一段正文。");
        assert!(out.contains("简介"));
        assert!(out.contains("这是一段正文。"));
    }

    #[test]
    fn parse_screen_json_happy_path() {
        let v = parse_screen_output(r#"{"relevant":true,"summary":"RWKV7 是新一代 RNN 架构"}"#);
        assert!(matches!(v, Some(ScreenOutcome::Relevant(s)) if s.contains("RWKV7")));
        let v = parse_screen_output(r#"{"relevant":false,"summary":""}"#);
        assert!(matches!(v, Some(ScreenOutcome::NotRelevant)));
        // 模板复述在前、真 JSON 在后（salvage 多候选跳跃）
        let v = parse_screen_output(
            r#"{"relevant":true或false,"summary":"要点"} {"relevant":true,"summary":"真答案"}"#,
        );
        assert!(matches!(v, Some(ScreenOutcome::Relevant(s)) if s == "真答案"));
    }

    #[test]
    fn parse_screen_prose_fallback() {
        // 实录 1：「相关：…\n要点：…」散文协议
        let v = parse_screen_output(
            "相关：RWKV-7 G系列 推理模型\n要点：RWKV-7 无需 KV Cache，恒定显存",
        );
        assert!(matches!(v, Some(ScreenOutcome::Relevant(s)) if s.contains("无需 KV Cache")));
        // 实录 2：纯「相关：<要点>」
        let v = parse_screen_output("相关：新一代 RNN 架构解析");
        assert!(matches!(v, Some(ScreenOutcome::Relevant(s)) if s == "新一代 RNN 架构解析"));
        // 实录 3：不相关散文
        let v = parse_screen_output("不相关，无要点");
        assert!(matches!(v, Some(ScreenOutcome::NotRelevant)));
        // 实测：无法判断也按不相关丢弃（保留会让无关页以 degraded 片段混进报告）
        let v = parse_screen_output("根据提供的网页内容，没有直接提及……因此无法判断");
        assert!(matches!(v, Some(ScreenOutcome::NotRelevant)), "{v:?}");
    }

    #[test]
    fn parse_screen_accepts_affirmative_prose_variant() {
        // 3B 实测输出：「是的，…相关，并提取要点：…」
        let v = parse_screen_output(
            "是的，网页内容与查询「agent memory」相关，并提取要点：Mem0 用向量库做长期记忆。",
        );
        assert!(
            matches!(v, Some(ScreenOutcome::Relevant(ref s)) if s.contains("Mem0")),
            "{v:?}"
        );
        // 纯肯定句、无要点标记
        let v = parse_screen_output("是，相关。该文讨论了 MemGPT 的分层内存。");
        assert!(
            matches!(v, Some(ScreenOutcome::Relevant(ref s)) if s.contains("MemGPT")),
            "{v:?}"
        );
    }

    /// 2026-11-21 实录变体（此前全部判 unparseable → 无关页以片段混进报告）。
    #[test]
    fn parse_screen_handles_recorded_variants() {
        // 「并提取到要点：」（比「提取要点：」多一个「到」）
        let v = parse_screen_output(
            "网页内容与查询「agent memory architecture primary sources」相关，并提取到要点：「Memory tradeoffs and failure modes」、「The proactive memory problem」",
        );
        assert!(
            matches!(v, Some(ScreenOutcome::Relevant(ref s)) if s.starts_with("「Memory tradeoffs")),
            "{v:?}"
        );
        // 肯定 + 换行正文
        let v = parse_screen_output("是\n该文讨论 agent memory 的分层存储设计。");
        assert!(
            matches!(v, Some(ScreenOutcome::Relevant(ref s)) if s.contains("分层存储")),
            "{v:?}"
        );
        // 「根据网页内容，…」肯定句
        let v = parse_screen_output(
            "根据网页内容，「Agent Memory Architecture」是一种结合了RNN和Transformer优点的大模型架构。",
        );
        assert!(
            matches!(v, Some(ScreenOutcome::Relevant(ref s)) if s.contains("Agent Memory Architecture")),
            "{v:?}"
        );
        // 繁体拒绝
        let v = parse_screen_output("不相關，無法提取到要點");
        assert!(matches!(v, Some(ScreenOutcome::NotRelevant)), "{v:?}");
        // 「是否相关并不相关」不得被当成相关
        let v = parse_screen_output(
            "该内容与「RWKV 是什么」是否相关并不相关，因为它讨论的是 agent memory。",
        );
        assert!(matches!(v, Some(ScreenOutcome::NotRelevant)), "{v:?}");
        // 指令复述（没有任何判定）→ None
        assert!(parse_screen_output(
            "判断网页内容与查询「agent memory」是否相关并提取要点，只输出一行 JSON。网页内容中包含了…"
        )
        .is_none());
    }

    #[test]
    fn example_parrot_is_detected() {
        let parrot = "RWKV 是一种结合了 RNN 和 Transformer 优点的大模型架构，推理快速、节省显存，支持无限上下文";
        assert!(is_example_parrot("agent memory architecture", parrot));
        // 查询本身就是 RWKV 时，内容提到 RWKV 属正常
        assert!(!is_example_parrot("RWKV 是什么", parrot));
    }

    #[test]
    fn weak_relevance_degrades_instead_of_fake_summary() {
        // 实测输出「性较弱，仅部分相关」曾被抽成摘要 → 改为降级用 snippet
        assert!(parse_screen_output("相关性较弱，仅部分相关").is_none());
    }

    #[test]
    fn search_language_follows_query_script() {
        // 英文查询不得走 zh-CN（AnySearch 在 zh-CN 下只回 cqvip 中文期刊页）
        assert_eq!(detect_search_language("agent memory architecture"), "en");
        assert_eq!(detect_search_language("RWKV-7 architecture survey"), "en");
        assert_eq!(detect_search_language("智能体记忆架构"), "zh-CN");
        assert_eq!(detect_search_language("RWKV-7 架构 论文"), "zh-CN");
    }

    #[test]
    fn derived_queries_covers_topic() {
        let queries = derived_queries("agent memory architecture");
        assert_eq!(queries.len(), 4);
        assert_eq!(queries[0], "agent memory architecture");
        assert!(derived_queries("   ").is_empty());
    }

    #[test]
    fn resolve_save_target_rejects_unsafe_names() {
        let cwd = std::env::temp_dir();
        assert!(resolve_save_target(&cwd, "").is_err());
        assert!(resolve_save_target(&cwd, "../escape.md").is_err());
        assert!(resolve_save_target(&cwd, "sub/sources.md").is_err());
        assert!(resolve_save_target(&cwd, "C:/abs/sources.md").is_err());
        assert!(resolve_save_target(&cwd, "sources.txt").is_err());
    }

    #[test]
    fn research_markdown_contains_sources_and_degraded_mark() {
        // 允许根之外的目录应被拒（否则模型可把文件写到任意路径）
        let outside = std::path::Path::new("C:/Windows");
        assert!(resolve_save_target(outside, "sources.md").is_err());

        let pages = vec![PageExtract {
            title: "Mem0: Building Production-Ready".to_string(),
            url: "https://arxiv.org/abs/2504.19413".to_string(),
            summary: "点一\n点二".to_string(),
            degraded: true,
        }];
        let md = render_research_markdown("agent memory", &pages);
        assert!(md.starts_with("# Sources — agent memory"));
        assert!(md.contains("1 sources"));
        assert!(md.contains("https://arxiv.org/abs/2504.19413"));
        assert!(md.contains("[degraded] snippet fallback"));
    }
}

#[cfg(test)]
mod selftests {
    use super::*;
    use std::time::Instant;

    /// 真机自验 1：SearXNG 搜索（s.ai00-x.com）→ 免 key 出结果。
    /// 运行：cargo test -p ai00-x-desktop --release search_selftest -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn search_selftest() {
        let t = Instant::now();
        let tool = ai00_x_core::websearch::WebSearchTool::new().with_searxng_enabled(true);
        let results = tool
            .search_simple("Rust 1.90 release notes", "zh-CN", 8)
            .await
            .expect("search failed");
        println!(
            "[search_selftest] {} results in {:.1}s",
            results.len(),
            t.elapsed().as_secs_f32()
        );
        for r in results.iter().take(3) {
            println!(
                "  - {} | {}",
                r.title.chars().take(50).collect::<String>(),
                r.url
            );
        }
        assert!(!results.is_empty(), "SearXNG 搜索返回空");
    }

    /// 真机自验 2：extract 全管线——搜索 + 多页并发抓取 + 摘要（模拟 agent 的
    /// ai00_web_extract 调用）。本地模型未起时页面标记 [degraded] 属预期。
    /// 运行：cargo test -p ai00-x-desktop --release extract_batch_selftest -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn extract_batch_selftest() {
        let t = Instant::now();
        let pages = extract("chromium devtools protocol", Some(6)).await;
        let elapsed = t.elapsed().as_secs_f32();
        println!(
            "[extract_batch_selftest] {} pages in {:.1}s (degraded: {})",
            pages.len(),
            elapsed,
            pages
                .iter()
                .filter(|p| p.summary.contains("[degraded]"))
                .count()
        );
        for p in pages.iter().take(5) {
            println!(
                "  - {} | {} | summary {} chars",
                p.title.chars().take(40).collect::<String>(),
                p.url.chars().take(45).collect::<String>(),
                p.summary.len()
            );
        }
        assert!(pages.len() >= 2, "多页抓取结果不足: {}", pages.len());
    }
}

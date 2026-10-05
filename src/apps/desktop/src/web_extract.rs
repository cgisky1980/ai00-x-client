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
const SCREEN_MAX_TOKENS: usize = 256;

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

/// web 有效信息提取主流程：搜索 → 并发抓取 → 并发本地筛选。
pub async fn extract(query: &str, max_results: Option<usize>) -> Vec<PageExtract> {
    let max_results = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS_CAP);
    // SearXNG 自建实例（s.ai00-x.com，2026-10-02 部署）已作为主搜索源，
    // 此处显式开启 fallback 链：AnySearch（有 key）→ SearXNG →（无则空）
    let results = WebSearchTool::new()
        .with_searxng_enabled(true)
        .search_simple(query, "zh-CN", max_results)
        .await
        .unwrap_or_else(|e| {
            log::warn!("[web-extract] search failed: {e}");
            Vec::new()
        });
    if results.is_empty() {
        log::warn!("[web-extract] query={query:?} returned 0 results");
        return Vec::new();
    }
    log::info!(
        "[web-extract] query={query:?} {} results, fetching concurrently",
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
    let html = String::from_utf8_lossy(&buf).to_string();
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
enum ScreenOutcome {
    /// 相关，附模型摘要。
    Relevant(String),
    /// 不相关，丢弃该页。
    NotRelevant,
}

/// 解析筛选输出：JSON 优先；散文协议兜底（3B 模型稳定产出
/// 「相关：<要点>」/「要点：…」/「不相关…」散文，2026-09-11 三轮实录）。
/// 返回 None = 完全无法解析（调用方 snippet 降级收录）。
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
    // 2) 散文协议兜底
    let t = text.trim();
    let body = t
        .strip_prefix("相关：")
        .or_else(|| t.strip_prefix("相关:"))
        .map(str::trim);
    if let Some(mut body) = body {
        // 「相关：…\n要点：…」→ 优先取要点段（注意「要点：」全角冒号为 9 字节）
        if let Some(pos) = body.find("要点：") {
            body = body[pos + "要点：".len()..].trim();
        } else if let Some(pos) = body.find("要点:") {
            body = body[pos + "要点:".len()..].trim();
        }
        if !body.is_empty() {
            return Some(ScreenOutcome::Relevant(body.chars().take(500).collect()));
        }
        return None;
    }
    if t.starts_with("不相关") || t.starts_with("不 相关") {
        return Some(ScreenOutcome::NotRelevant);
    }
    None
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
        while let Some(event) = rx.recv().await {
            match event {
                InferenceEvent::Done { text: t, .. } => {
                    text = t;
                    break;
                }
                InferenceEvent::Error(e) => return Err(e),
                _ => {}
            }
        }
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
        Some(ScreenOutcome::Relevant(summary)) => Some(PageExtract {
            title: page.title.clone(),
            url: page.url.clone(),
            summary,
            degraded: false,
        }),
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
    while let Some(event) = rx.recv().await {
        match event {
            InferenceEvent::Done {
                text: t,
                stop_sequence,
                ..
            } => {
                text = t;
                hit_len = stop_sequence.is_none();
                break;
            }
            InferenceEvent::Error(e) => return Err(e),
            _ => {}
        }
    }
    Ok((text.trim().to_string(), hit_len))
}

/// 单块摘要（map）：质量门拦截 → top_p=0.5 重试一次 → 仍不合格用原文截断降级。
async fn summarize_chunk(
    idx: usize,
    total: usize,
    chunk: &str,
    focus: Option<&str>,
) -> (String, bool) {
    let focus_clause = focus
        .map(|f| format!("，重点关注「{f}」"))
        .unwrap_or_default();
    let prompt = format!(
        "Instruction: 以下是长文的第 {idx}/{total} 部分，请总结其要点{focus_clause}，控制在 {SUMMARIZE_CHUNK_TARGET} 字以内。\n\nInput: {chunk}\n\nResponse: "
    );
    for top_p in [0.3, 0.5] {
        let attempt = tokio::time::timeout(
            Duration::from_secs(SCREEN_TIMEOUT_SECS),
            summarize_once(prompt.clone(), SCREEN_MAX_TOKENS, top_p),
        )
        .await;
        if let Ok(Ok((text, hit_len))) = attempt {
            if crate::tool_session::quality_gate(&text, hit_len).is_ok() {
                return (text, false);
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
    let focus_clause = focus
        .map(|f| format!("，重点关注「{f}」"))
        .unwrap_or_default();
    let char_count = text.chars().count();

    if char_count <= SUMMARIZE_SINGLE_SHOT_CHARS {
        let prompt = format!(
            "Instruction: 请总结以下文本{focus_clause}，控制在 {max_length} 字以内。\n\nInput: {text}\n\nResponse: "
        );
        return match tokio::time::timeout(
            Duration::from_secs(SCREEN_TIMEOUT_SECS * 2),
            summarize_once(prompt, max_length * 2, 0.3),
        )
        .await
        {
            Ok(Ok((summary, hit_len)))
                if crate::tool_session::quality_gate(&summary, hit_len).is_ok() =>
            {
                SummarizeResult {
                    summary,
                    degraded: false,
                }
            }
            _ => {
                log::warn!("[text-summarize] single-shot failed/degraded");
                SummarizeResult {
                    summary: text.chars().take(max_length).collect(),
                    degraded: true,
                }
            }
        };
    }

    // map：text-splitter 按 ~4000 字符切块（语义边界），并发逐块摘要
    let splitter = text_splitter::TextSplitter::new(SUMMARIZE_CHUNK_CHARS);
    let chunks: Vec<&str> = splitter.chunks(text).collect();
    let total = chunks.len();
    log::info!("[text-summarize] map-reduce: {char_count} chars -> {total} chunks");
    let partials: Vec<(String, bool)> = futures::future::join_all(
        chunks
            .iter()
            .enumerate()
            .map(|(i, c)| summarize_chunk(i + 1, total, c, focus)),
    )
    .await;
    let any_degraded = partials.iter().any(|(_, d)| *d);
    let joined = partials
        .iter()
        .enumerate()
        .map(|(i, (s, _))| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");

    // reduce：合并各块摘要为连贯总结
    let prompt = format!(
        "Instruction: 以下是一篇长文各部分的要点，请合并成一篇连贯的总结{focus_clause}，控制在 {max_length} 字以内。\n\nInput: {joined}\n\nResponse: "
    );
    match tokio::time::timeout(
        Duration::from_secs(SCREEN_TIMEOUT_SECS * 2),
        summarize_once(prompt, max_length * 2, 0.3),
    )
    .await
    {
        Ok(Ok((summary, hit_len)))
            if crate::tool_session::quality_gate(&summary, hit_len).is_ok() =>
        {
            SummarizeResult {
                summary,
                degraded: any_degraded,
            }
        }
        _ => {
            log::warn!("[text-summarize] reduce failed gate, returning joined partials");
            SummarizeResult {
                summary: joined,
                degraded: true,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // 完全无法解析 → None（调用方 snippet 降级）
        assert!(parse_screen_output("根据提供的网页内容，没有直接提及……因此无法判断").is_none());
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

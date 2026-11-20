//! AI 用量记账 —— plugin AI 通道（plugin_ai_complete）的本地消耗 ledger。
//!
//! 每次 plugin AI 调用落一条记录（模型/本地远程/token/耗时/业务 tag），
//! 按月存 `{data_dir}/Ai00-X/ai_usage/records-YYYY-MM.json`（读改写追加）。
//! 本地 RWKV 的 token 为启发式估算（providers/rwkv/request.rs 口径）。
//! `ai_usage_query` 聚合最近 N 天：总量/按日（本地 vs 远程）/按 tag 明细。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tokio::fs;

/// 记账目录：`{data_dir}/Ai00-X/ai_usage/`
fn ai_usage_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("ai_usage")
}

/// 月文件名 records-YYYY-MM.json（按记录时间戳归属）。
fn month_file(at_ms: u64) -> PathBuf {
    // 简化取月：由前端传入格式化好的日期也可，但记录端保持独立——
    // 用秒级时间戳换算年月（无 chrono 依赖，1970 起算的简易换算）
    let days = at_ms / 86_400_000;
    let (y, m) = year_month_from_days(days as i64);
    month_path(y, m)
}

/// 指定年月的账本路径（月文件命名的唯一出口）。
fn month_path(year: i64, month: u32) -> PathBuf {
    ai_usage_dir().join(format!("records-{}-{:02}.json", year, month))
}

/// 天数 → (年, 月)（1970-01-01 起算，含闰年）。
fn year_month_from_days(days: i64) -> (i64, u32) {
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let yd = if leap { 366 } else { 365 };
        if d < yd {
            break;
        }
        d -= yd;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 1u32;
    for (idx, md) in month_days.iter().enumerate() {
        if d < *md {
            return (y, m);
        }
        d -= md;
        m = idx as u32 + 2;
    }
    (y, 12)
}

/// 一条用量记录（月文件 JSON 数组元素）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageRecord {
    /// 调用完成时刻（毫秒）
    pub at: u64,
    /// 调用来源插件 id（core 特性如 com.ai00x.core.todo 也在此列）
    pub plugin_id: String,
    /// 业务 tag（如 todo:assess:{goalId}；可空）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// 实际命中的模型名
    pub model: String,
    /// 是否本地推理（rwkv-local / gguf-local）
    pub local: bool,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// 调用耗时（毫秒）
    pub latency_ms: u64,
    /// 首字节时间（毫秒）：流式请求从发出到第一个 chunk 的耗时。
    /// 旧记录没有该字段，读取侧按 `Option` 兼容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    /// dsh 会话 id（plugin AI 通道为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 调用方请求的逻辑/具体模型，区别于实际命中模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    /// 实际路由（remote/local/hybrid 等）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    /// 本地失败后升级远端的原因；无回退时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    /// 上游实际返回的缓存输入 token；未返回时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_prompt_tokens: Option<u32>,
    /// 是否有真实 usage。旧记录缺省视为历史口径已知；新记录缺 usage 必须显式 false。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_known: Option<bool>,
    /// 网关发往服务端的 `X-Request-Id`（服务端计费账本的 `request_id` 同值）。
    /// 用于把「本轮」的远端调用对到服务端积分账单上；本地调用为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// 用量文件读-改-写串行化：整月文件重写如果并发，会互相覆盖丢记录
/// （并行子代理同时回传用量即可复现）。锁只保护这一次文件操作，不阻塞 AI 主链路。
static USAGE_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 追加一条记录（失败仅告警，不阻塞 AI 调用主链路）。
pub async fn record_usage(rec: AiUsageRecord) {
    let _guard = USAGE_WRITE_LOCK.lock().await;
    let path = month_file(rec.at);
    let mut list: Vec<Value> = match fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    list.push(serde_json::to_value(&rec).unwrap_or(Value::Null));
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent).await {
            log::warn!("[ai-usage] create dir failed: {}", e);
            return;
        }
    }
    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = fs::write(&tmp, &json).await {
        log::warn!("[ai-usage] write failed: {}", e);
        return;
    }
    if let Err(e) = fs::rename(&tmp, &path).await {
        log::warn!("[ai-usage] commit failed: {}", e);
    }
}

// ---------------------------------------------------------------------------
// 查询命令
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageQueryRequest {
    /// 最近 N 天（1-90，缺省 7）
    #[serde(default)]
    pub days: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageQueryResponse {
    pub totals: AiUsageTotals,
    /// 按日升序（补空日），date = YYYY-MM-DD
    pub days: Vec<AiUsageDay>,
    /// 按 tag 聚合（全量，窗口内；前端自行过滤 goalId 归属）
    pub by_tag: BTreeMap<String, AiUsageTagAgg>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageTotals {
    pub calls: u64,
    /// 本地推理调用数（与 calls 的区别：calls 含远端）。
    pub local_calls: u64,
    pub local_tokens: u64,
    pub remote_tokens: u64,
    pub local_prompt: u64,
    pub local_completion: u64,
    pub remote_prompt: u64,
    pub remote_completion: u64,
    pub local_cached_prompt: u64,
    pub remote_cached_prompt: u64,
    /// 上游未提供 usage 的调用数；这些调用不计入 token 总量。
    pub unknown_usage_calls: u64,
    pub fallback_calls: u64,
    pub latency_ms_total: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageDay {
    pub date: String,
    pub local_tokens: u64,
    pub remote_tokens: u64,
    pub calls: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageTagAgg {
    pub calls: u64,
    pub local_tokens: u64,
    pub remote_tokens: u64,
}

/// 单日/单会话的本地 + 远端用量分项。
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSplit {
    pub calls: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_prompt_tokens: u64,
    /// 上游未提供 usage 的调用数（token 不计入上面三项）。
    pub unknown_usage_calls: u64,
    /// 本地失败后升级远端的次数。
    pub fallback_calls: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSessionResponse {
    pub session_id: String,
    pub since_ms: u64,
    pub local: AiUsageSplit,
    pub remote: AiUsageSplit,
    /// 窗口内**远端**调用的请求 id（去重、升序），用于到服务端计费账本核对积分。
    pub remote_request_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSessionRequest {
    pub session_id: String,
    /// 只统计该时刻之后的记录（毫秒）；缺省最近 24 小时。
    #[serde(default)]
    pub since_ms: Option<u64>,
    /// 一并统计的子会话（子代理）id：一次派发会花掉别的会话的额度，
    /// 「本轮消耗」必须把它们算进来，否则云端积分会少算。
    #[serde(default)]
    pub extra_session_ids: Vec<String>,
}

fn merge_split(split: &mut AiUsageSplit, record: &AiUsageRecord) {
    split.calls += 1;
    if record.usage_known.unwrap_or(true) {
        split.prompt_tokens += record.prompt_tokens as u64;
        split.completion_tokens += record.completion_tokens as u64;
        split.cached_prompt_tokens += record.cached_prompt_tokens.unwrap_or(0) as u64;
    } else {
        split.unknown_usage_calls += 1;
    }
    if record.fallback_reason.is_some() {
        split.fallback_calls += 1;
    }
}

/// 单次会话查询最多读取的月账本数。
///
/// 账本按月存，重启恢复「本轮消耗」只需回溯到 turn/start；即使跨年长会话也远不到 24 个月。
/// 设上界是为了让病态跨度（如前端误传 5 年前的 since）只读最近 24 个月，行为可预期且不会卡死。
const SESSION_USAGE_MAX_MONTHS: usize = 24;

/// 按 `since .. now` 实际跨度列出要读的月账本路径（无重复，按年月升序）。
///
/// 直接按年月索引逐月枚举（不用 31 天步长探测：31 天可整段跨过 28/30 天的月份，
/// 例如 1/31 + 31 天落在 3/3，二月的账本会被整月漏掉），保证中间任何月份都不漏。
/// 两端顺序颠倒时按区间处理；超过 `max_months` 时只保留最近的 `max_months` 个。
fn month_paths_between(since_ms: u64, now_ms: u64, max_months: usize) -> Vec<PathBuf> {
    if max_months == 0 {
        return Vec::new();
    }
    let lo = since_ms.min(now_ms) / 86_400_000;
    let hi = since_ms.max(now_ms) / 86_400_000;
    let (y0, m0) = year_month_from_days(lo as i64);
    let (y1, m1) = year_month_from_days(hi as i64);
    let start = y0 * 12 + i64::from(m0) - 1;
    let end = y1 * 12 + i64::from(m1) - 1;
    // 从最近的月份开始往回取，命中上限即停——病态跨度也只读 max_months 个文件
    let mut list = Vec::new();
    let mut idx = end;
    while idx >= start && list.len() < max_months {
        let y = idx.div_euclid(12);
        let m = idx.rem_euclid(12) as u32 + 1;
        list.push(month_path(y, m));
        idx -= 1;
    }
    list.reverse();
    list
}

/// 按会话聚合本地/远端用量（工作台「本轮消耗」与按会话对账）。
///
/// 只读 `since .. now` 实际跨度涉及的月账本（缺省 24h 只命中一个文件）。
#[tauri::command]
pub async fn ai_usage_session_usage(
    request: AiUsageSessionRequest,
) -> Result<AiUsageSessionResponse, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let since = request
        .since_ms
        .unwrap_or_else(|| now.saturating_sub(24 * 60 * 60 * 1000));

    let mut response = AiUsageSessionResponse {
        session_id: request.session_id.clone(),
        since_ms: since,
        local: AiUsageSplit::default(),
        remote: AiUsageSplit::default(),
        remote_request_ids: Vec::new(),
    };
    let mut request_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    // 主会话 + 本轮派发的子会话（子代理）一起统计
    let mut sessions: std::collections::BTreeSet<&str> =
        std::collections::BTreeSet::from([request.session_id.as_str()]);
    for id in &request.extra_session_ids {
        if !id.is_empty() {
            sessions.insert(id.as_str());
        }
    }

    // 按 since..now 实际跨度读月账本（缺省 24h 只命中一个文件）
    for path in month_paths_between(since, now, SESSION_USAGE_MAX_MONTHS) {
        let Ok(content) = fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(list) = serde_json::from_str::<Vec<AiUsageRecord>>(&content) else {
            continue;
        };
        for record in list {
            if record.at < since {
                continue;
            }
            let sid = record.session_id.as_deref();
            if !matches!(sid, Some(s) if sessions.contains(s)) {
                continue;
            }
            if record.local {
                merge_split(&mut response.local, &record);
            } else {
                merge_split(&mut response.remote, &record);
                if let Some(id) = record.request_id.filter(|id| !id.is_empty()) {
                    request_ids.insert(id);
                }
            }
        }
    }
    response.remote_request_ids = request_ids.into_iter().collect();

    Ok(response)
}

/// 天起始毫秒（本地时区）→ YYYY-MM-DD。
fn day_key(at_ms: u64) -> String {
    let days = (at_ms / 86_400_000) as i64;
    let (y, m) = year_month_from_days(days);
    // 重新求当月第几天：从 year_month_from_days 拿不到 d，直接重算
    let mut d = days;
    {
        let mut yy = 1970i64;
        while yy < y {
            let leap = (yy % 4 == 0 && yy % 100 != 0) || yy % 400 == 0;
            d -= if leap { 366 } else { 365 };
            yy += 1;
        }
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut day = d + 1;
    for (i, md) in month_days.iter().enumerate() {
        if (i as u32 + 1) == m {
            break;
        }
        day -= md;
    }
    format!("{}-{:02}-{:02}", y, m, day.max(1))
}

/// 聚合查询最近 N 天用量（本地 ledger）。
#[tauri::command]
pub async fn ai_usage_query(request: AiUsageQueryRequest) -> Result<AiUsageQueryResponse, String> {
    let days = request.days.unwrap_or(7).clamp(1, 90) as i64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let since = now.saturating_sub((days as u64) * 86_400_000);

    // 读窗口涉及的月文件（当前月 + 往前 ceil(days/31)+1 个月兜底）
    let mut records: Vec<AiUsageRecord> = Vec::new();
    let months_back = (days / 31 + 2) as u64;
    for back in 0..=months_back {
        let at = now.saturating_sub(back * 31 * 86_400_000);
        let path = month_file(at);
        if let Ok(content) = fs::read_to_string(&path).await {
            if let Ok(list) = serde_json::from_str::<Vec<AiUsageRecord>>(&content) {
                records.extend(list);
            }
        }
    }

    let mut resp = AiUsageQueryResponse {
        totals: AiUsageTotals::default(),
        days: Vec::new(),
        by_tag: BTreeMap::new(),
    };

    // 按日桶（含空日，升序）
    let mut day_map: BTreeMap<String, AiUsageDay> = BTreeMap::new();
    for i in (0..days).rev() {
        let t = now.saturating_sub((i as u64) * 86_400_000);
        let key = day_key(t);
        day_map.insert(
            key.clone(),
            AiUsageDay {
                date: key,
                ..Default::default()
            },
        );
    }

    for r in records.into_iter().filter(|r| r.at >= since) {
        let usage_known = r.usage_known.unwrap_or(true);
        let tokens = if usage_known {
            (r.prompt_tokens + r.completion_tokens) as u64
        } else {
            0
        };
        let cached = r.cached_prompt_tokens.unwrap_or(0) as u64;
        let t = &mut resp.totals;
        t.calls += 1;
        t.latency_ms_total += r.latency_ms;
        if !usage_known {
            t.unknown_usage_calls += 1;
        }
        if r.fallback_reason.is_some() {
            t.fallback_calls += 1;
        }
        if r.local {
            t.local_calls += 1;
            t.local_tokens += tokens;
            t.local_prompt += r.prompt_tokens as u64;
            t.local_completion += r.completion_tokens as u64;
            t.local_cached_prompt += cached;
        } else {
            t.remote_tokens += tokens;
            t.remote_prompt += r.prompt_tokens as u64;
            t.remote_completion += r.completion_tokens as u64;
            t.remote_cached_prompt += cached;
        }
        if let Some(day) = day_map.get_mut(&day_key(r.at)) {
            day.calls += 1;
            if r.local {
                day.local_tokens += tokens;
            } else {
                day.remote_tokens += tokens;
            }
        }
        if let Some(tag) = r.tag.as_deref() {
            let agg = resp.by_tag.entry(tag.to_string()).or_default();
            agg.calls += 1;
            if r.local {
                agg.local_tokens += tokens;
            } else {
                agg.remote_tokens += tokens;
            }
        }
    }
    resp.days = day_map.into_values().collect();
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_usage_record_keeps_optional_fields_compatible() {
        let raw = json!({
            "at": 1,
            "pluginId": "legacy",
            "model": "remote-model",
            "local": false,
            "promptTokens": 10,
            "completionTokens": 5,
            "latencyMs": 20
        });
        let record = serde_json::from_value::<AiUsageRecord>(raw).ok();
        assert!(record.is_some());
        if let Some(record) = record {
            assert_eq!(record.prompt_tokens, 10);
            assert_eq!(record.session_id, None);
            assert_eq!(record.usage_known, None);
        }
    }

    #[test]
    fn year_month_roundtrip() {
        assert_eq!(year_month_from_days(0), (1970, 1));
        assert_eq!(year_month_from_days(31), (1970, 2));
        assert_eq!(year_month_from_days(365), (1971, 1));
        // 2026-01-01 = 56 年（14 个闰日）= 20454 天
        assert_eq!(year_month_from_days(20454), (2026, 1));
    }

    #[test]
    fn day_key_format() {
        assert_eq!(day_key(0), "1970-01-01");
    }

    /// 2026-01-01 的毫秒时间戳（天数见 year_month_roundtrip）。
    const JAN_2026_MS: u64 = 20_454 * 86_400_000;
    const DAY_MS: u64 = 86_400_000;

    #[test]
    fn month_paths_cover_cross_month_window_without_duplicates() {
        let since = JAN_2026_MS;
        let now = since + 70 * DAY_MS;
        let paths = month_paths_between(since, now, SESSION_USAGE_MAX_MONTHS);
        assert!(
            paths.len() >= 3,
            "70 天窗口应至少命中 3 个月: {}",
            paths.len()
        );
        let mut unique = paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), paths.len(), "月份路径不应重复");
    }

    #[test]
    fn month_paths_single_month_window() {
        let paths = month_paths_between(JAN_2026_MS + 4 * DAY_MS, JAN_2026_MS + 19 * DAY_MS, 24);
        assert_eq!(paths.len(), 1, "同月窗口只应读一个文件: {:?}", paths);
    }

    #[test]
    fn month_paths_capped_for_huge_span() {
        let max_months = 24;
        let paths = month_paths_between(0, 5 * 365 * DAY_MS, max_months);
        assert!(!paths.is_empty());
        assert!(
            paths.len() <= max_months,
            "超长跨度应被截断到 {}，实际 {}",
            max_months,
            paths.len()
        );
    }
}

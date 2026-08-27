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
    ai_usage_dir().join(format!("records-{}-{:02}.json", y, m))
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
    /// 是否本地推理（rwkv-local）
    pub local: bool,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// 调用耗时（毫秒）
    pub latency_ms: u64,
}

/// 追加一条记录（失败仅告警，不阻塞 AI 调用主链路）。
pub async fn record_usage(rec: AiUsageRecord) {
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
    pub local_tokens: u64,
    pub remote_tokens: u64,
    pub local_prompt: u64,
    pub local_completion: u64,
    pub remote_prompt: u64,
    pub remote_completion: u64,
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
        let tokens = (r.prompt_tokens + r.completion_tokens) as u64;
        let t = &mut resp.totals;
        t.calls += 1;
        t.latency_ms_total += r.latency_ms;
        if r.local {
            t.local_tokens += tokens;
            t.local_prompt += r.prompt_tokens as u64;
            t.local_completion += r.completion_tokens as u64;
        } else {
            t.remote_tokens += tokens;
            t.remote_prompt += r.prompt_tokens as u64;
            t.remote_completion += r.completion_tokens as u64;
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
}

"""Build the v2 context-aware training dataset.

Design principle (user decision): at runtime a summary is present with HIGH
probability (every turn from the 2nd onward), so the TRAINING distribution
must mirror that — most samples use the live input format
`Summary: {...}\nRequest: {...}`.

Construction from golden_balanced.jsonl (real requests, human tiers):
  - ~70% of requests get a tier-matched session summary prepended (same tier
    label; the summary is same-complexity background, it does NOT shift the
    tier — the request itself stays the dominant signal).
  - ~30% stay bare (first-turn / summary-generation-failure distribution).
  - No request appears twice (no train/test leakage across formats).

Boundary samples ("继续" shifting tiers by context) come separately from
gen_context_augment.py and are merged TRAIN-ONLY via train_mlp.py --data.
"""

import argparse
import json
import random
from pathlib import Path

# Tier-matched summary pools. The summary describes an ongoing session whose
# complexity matches the request's tier, so the paired label stays the tier
# of the request itself.

LIGHT_SUMMARIES = [
    "Casual chat about pets, food, and weekend plans. No task in progress.",
    "User asked about the weather today. Answered briefly, conversation is relaxed.",
    "Simple Q&A about the app's interface and shortcuts. All questions answered.",
    "闲聊：用户在聊附近的餐厅和周末安排。没有进行中的任务。",
    "User greeted the assistant, exchanged a joke and small talk.",
    "High-level chat about the difference between TCP and UDP, purely conceptual.",
    "User asked for one short translation of a greeting. Delivered, chat winding down.",
    "Quick fact lookup about geography. Answered in one line.",
    "轻松对话：讨论最近看的电影。无任务上下文。",
    "Friendly exchange about morning routines and coffee preferences.",
    "User thanked the assistant for earlier help; brief polite closing chat.",
    "闲聊关于旅行计划的闲谈，没有具体任务。",
]

MID_SUMMARIES = [
    "Writing a Python script to sync files with checksum verification. Core upload logic done; polishing the manifest.",
    "Drafting a technical blog post about linear RNN inference. Outline done, intro written, expanding the benchmark section.",
    "Building a settings page with status rows and dropdowns. Layout done, event wiring remains.",
    "Translating a README into Chinese, about halfway through; keeping commands untranslated.",
    "正在写一个正则表达式提取日志字段的工具。时间戳模式已通，处理多行堆栈中。",
    "Composing a unit-test suite for routing rules: main cases covered, edge thresholds remain.",
    "Setting up a CI workflow: build matrix works, cache restore is flaky on macOS.",
    "Writing a design doc explaining an embedding approach; math section done, adding the training recipe.",
    "正在整理一份 API 文档，主要接口已经写完，剩余错误码说明部分。",
    "Building a small CLI tool for file renaming; dry-run mode works, applying changes next.",
    "Drafting release notes for v0.3: features listed, known-issues section remains.",
    "正在为项目补全注释和 docstring，核心模块已完成一半。",
    "Writing a tutorial for the download manager API; first two sections done.",
    "正在做一份数据清洗脚本，去重逻辑完成，正在处理空值填充。",
]

HEAVY_SUMMARIES = [
    "Debugging a Rust FFI crash in the llama.cpp bindings. Crash on aarch64 only, suspect struct layout mismatch after a submodule upgrade.",
    "Refactoring an async pipeline in Rust; migrating the classification head to a new input format while keeping clippy clean and tests green.",
    "Investigating production 401 errors from the AI gateway. Logs show expired tokens; tracing the auth chain across three services.",
    "Optimizing a download manager: concurrent range requests exhaust Windows ports (10048); analyzing WinSock behavior.",
    "User is reviewing a long legal document (Chinese). Translating clause by clause, clause 12 of 30; terminology must match a glossary.",
    "调试前端 WebSocket 断连问题。心跳帧格式错误，正在对照 RFC 6455 检查帧编码，已排除网络层原因。",
    "分析线上服务的内存泄漏。heap dump 显示缓存条目只增不减，怀疑 LRU 淘汰逻辑有 off-by-one。",
    "Debugging an intermittent CI failure: passes locally, times out on runners; bisected to a flaky integration test.",
    "Reviewing a multi-file refactor PR: 40 files touched, public API docs need regeneration; checking each signature change.",
    "Resolving a data race reported by ThreadSanitizer in the scheduler; two threads contend on the state cache.",
    "Troubleshooting GPU kernel recompilation stalls (~0.5s each) on every new sequence length; root-causing cache invalidation.",
    "排查分布式锁的脑裂问题：两个节点同时持有锁，正在分析租约续期日志与时钟偏移。",
    "Analyzing a performance regression after an upgrade: p99 latency tripled; profiling points to a new serialization path.",
    "Investigating a data corruption bug in the write-ahead log; partial writes on crash, checking fsync ordering.",
    "重构状态机以消除竞态：迁移中需要保持旧事件兼容，正在逐条验证迁移路径。",
    "Debugging a render loop leak in a canvas app: listeners accumulate on remount; designing a teardown contract.",
]

TIER_POOLS = {0: LIGHT_SUMMARIES, 1: LIGHT_SUMMARIES, 2: MID_SUMMARIES, 3: HEAVY_SUMMARIES}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", default="data/golden_balanced.jsonl")
    ap.add_argument("--out", default="data/dataset_v2.jsonl")
    ap.add_argument("--with-summary-ratio", type=float, default=0.7)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    rows = []
    with Path(args.golden).open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    out_rows = []
    counts = {"bare": 0, "summary": 0}
    for row in rows:
        tier = int(row["tier"])
        if rng.random() < args.with_summary_ratio:
            summary = rng.choice(TIER_POOLS[tier])
            out_rows.append({
                "text": f"Summary: {summary}\nRequest: {row['text']}",
                "tier": tier,
            })
            counts["summary"] += 1
        else:
            out_rows.append({"text": row["text"], "tier": tier})
            counts["bare"] += 1

    rng.shuffle(out_rows)
    out = Path(__file__).parent / args.out
    with out.open("w", encoding="utf-8") as f:
        for r in out_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    tiers = [r["tier"] for r in out_rows]
    print(f"[dataset-v2] wrote {len(out_rows)} samples -> {out}")
    print(f"[dataset-v2] format: {counts['summary']} with-summary / {counts['bare']} bare "
          f"({counts['summary'] / len(out_rows):.0%} summary, mirroring runtime)")
    print(f"[dataset-v2] tier distribution: "
          f"R0={tiers.count(0)} R1={tiers.count(1)} R2={tiers.count(2)} R3={tiers.count(3)}")


if __name__ == "__main__":
    main()

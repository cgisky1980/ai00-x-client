"""Generate context-aware training samples for the router MLP head.

Each sample pairs a session summary (simulating the runtime rolling summary
produced by rwkv-local) with a follow-up request, in the EXACT runtime
classify-input format:

    Summary: {summary}\nRequest: {request}

Core design: boundary pairs — the SAME follow-up request is paired with
DIFFERENT summaries to teach the head that context shifts the tier
("继续" inside a debugging session -> R3; inside chit-chat -> R0/R1).
Output is JSONL {"text","tier"}, isomorphic to golden_balanced.jsonl, to be
merged into TRAIN ONLY (train_mlp.py --data treats extra files that way).
"""

import argparse
import json
import random
from pathlib import Path

# ---------------------------------------------------------------------------
# Summary pools. Written to resemble actual model-generated rolling summaries:
# short, factual, telegraphic, mixed zh/en. Each has a {slot} or two.
# ---------------------------------------------------------------------------

# High-complexity task summaries (R2/R3 context)
HEAVY_SUMMARIES = [
    "Debugging a Rust FFI crash in the llama.cpp bindings. Crash happens on aarch64 only, "
    "suspect a struct layout mismatch after the submodule upgrade. Already diffed llama.h once.",
    "Refactoring the smart-router pipeline in Rust. Currently migrating the classification head "
    "to a new input format; clippy must stay clean and unit tests must pass.",
    "Working through a CUDA out-of-memory issue in the RWKV inference pool. VRAM leaks on "
    "variable-length prefills; already fixed two of three leak sites.",
    "Investigating production 401 errors from the AI gateway. Logs show expired tokens; need to "
    "trace the auth chain across three services and patch the refresh logic.",
    "Optimizing the download manager: concurrent range requests exhaust Windows ports (10048). "
    "Analyzing WinSock behavior, considering a single-connection fallback.",
    "User is reviewing a long legal document (Chinese). Translating clause by clause, currently "
    "on clause 12 of 30; terminology must stay consistent with a provided glossary.",
    "调试前端 WebSocket 断连问题。断点显示心跳帧格式错误，正在对照 RFC 6455 检查帧编码，"
    "已排除网络层原因。",
    "分析线上服务的内存泄漏。heap dump 显示缓存条目只增不减，怀疑 LRU 淘汰逻辑有 "
    "off-by-one，正在核对数据结构实现。",
    "Debugging an intermittent CI failure: tests pass locally but time out on GitHub runners. "
    "Already bisected to a flaky integration test; next step is a retry wrapper.",
    "Reviewing a multi-file refactor PR: the rename touches 40 files and the public API docs "
    "need regeneration; checking each signature change against callers.",
    "Resolving a data race reported by ThreadSanitizer in the inference scheduler. Two threads "
    "contend on the state cache; designing a lock-free alternative.",
    "Troubleshooting GPU kernel recompilation stalls (~0.5s each) triggered by every new "
    "sequence length. Root-causing the cache invalidation path in the prefill graph.",
]

# Mid-complexity task summaries (R2 context)
MID_SUMMARIES = [
    "Writing a Python script to sync model files to ModelScope and HuggingFace with sha256 "
    "verification. Core upload logic done; polishing the manifest regeneration.",
    "Drafting a technical blog post about linear RNN inference on consumer GPUs. Outline done, "
    "intro written, currently expanding the benchmark section.",
    "Building a Tauri settings page for the smart router: status row and tier dropdowns done, "
    "test panel wiring remains.",
    "Translating the README into Chinese. About halfway through; keeping the install commands "
    "untranslated.",
    "正在写一个正则表达式提取日志字段的工具。基础模式已能匹配时间戳，正在处理多行堆栈的情况。",
    "Composing a unit-test suite for the postprocessing rules: safety-upgrade and sticky-tier "
    "cases covered, edge thresholds remain.",
    "Setting up a GitHub Actions workflow: build matrix for 5 platforms works; cache restore is "
    "flaky on macOS.",
    "Explaining the RWKV state-embedding approach in a design doc; the math section is done, "
    "adding the training recipe next.",
]

# Light task summaries (R1 context)
LIGHT_SUMMARIES = [
    "Casual chat about pets and weekend plans. No task in progress.",
    "User asked what the weather is like in Shanghai today. Answered briefly.",
    "Simple Q&A about the app's keyboard shortcuts. All questions answered.",
    "闲聊：用户在问附近的餐厅推荐。没有进行中的任务。",
    "User greeted the assistant and asked for a quick joke. One joke delivered.",
    "Brief exchange about the difference between TCP and UDP, at a high level.",
    "User asked to translate one greeting sentence to Japanese. Done.",
    "Quick fact lookup: capital of Australia. Answered with one line.",
]

# ---------------------------------------------------------------------------
# Follow-up requests. Dependency requests need summary context to tier
# correctly; standalone requests keep their context-free tier.
# ---------------------------------------------------------------------------

# (request, tier_heavy, tier_mid, tier_light) — boundary pairs. Each tier is
# annotated EXPLICITLY per summary class (no derivation): heavy = debugging /
# complex refactor context; mid = active writing/translation/build task; light
# = idle chat / trivial Q&A.
BOUNDARY_REQUESTS = [
    ("继续", 3, 2, 0),
    ("continue", 3, 2, 0),
    ("继续吧", 3, 2, 0),
    ("go on", 3, 2, 0),
    ("改成中文", 2, 2, 1),          # heavy: redo real work; mid: translation task continues; light: trivial
    ("translate it to Chinese", 2, 2, 1),
    ("换成 python 实现", 2, 2, 1),
    ("rewrite it in Python", 2, 2, 1),
    ("再详细一点", 2, 2, 1),
    ("explain more", 2, 2, 1),
    ("换个思路试试", 2, 2, 1),
    ("try a different approach", 2, 2, 1),
    ("这里没看懂，再解释下", 2, 2, 1),
    ("I don't get this part, explain again", 2, 2, 1),
    ("对，就是这个方向，继续", 3, 2, 0),
    ("yes that direction, continue", 3, 2, 0),
    ("把上面的结论整理成列表", 2, 2, 1),
    ("summarize the above as a list", 2, 2, 1),
    ("应用到另一个文件", 2, 2, 1),
    ("apply the same fix to the other file", 2, 2, 1),
    ("直接全部改掉", 2, 2, 1),
    ("just replace them all", 2, 2, 1),
    ("先这样，等下继续", 1, 1, 1),
    ("that's fine for now", 1, 1, 1),
]

# Plain mid/heavy follow-ups that stay in their tier with or without context.
MID_FOLLOWUPS = [
    "这一步为什么要加锁？",
    "why is a lock needed here?",
    "给我看下当前的完整代码",
    "show me the full current code",
    "跑一遍测试看看",
    "run the tests and show me",
    "把日志贴出来",
    "paste the relevant logs",
]
HEAVY_FOLLOWUPS = [
    "还是崩溃，堆栈变了，重新分析",
    "still crashes, the stack trace changed, analyze again",
    "内存又涨回来了，检查是否有其他泄漏点",
    "memory climbed back, look for other leak sites",
    "把这个修复提交成一个 commit",
    "turn the fix into a commit with a proper message",
    "评估一下这个方案的风险",
    "assess the risks of this approach",
]

# Light follow-ups that stay light regardless of summary.
LIGHT_FOLLOWUPS = [
    "好的",
    "明白了，谢谢",
    "got it, thanks",
    "哈哈，有意思",
    "cool",
    "就这样吧",
]


def make_sample(summary: str, request: str, tier: int) -> dict:
    text = f"Summary: {summary}\nRequest: {request}"
    return {"text": text, "tier": tier}


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate context-aware router samples")
    ap.add_argument("--out", default="data/context_augment.jsonl")
    ap.add_argument("--per-category", type=int, default=120,
                    help="variants per generator category")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    samples: list[dict] = []
    seen: set[str] = set()

    def add(s: dict) -> None:
        if s["text"] not in seen:
            seen.add(s["text"])
            samples.append(s)

    # 1. Boundary pairs — the core teaching signal. Every request pairs with
    #    ALL summary classes so the head learns context shifts the tier.
    for req, heavy_tier, mid_tier, light_tier in BOUNDARY_REQUESTS:
        for _ in range(args.per_category // 4):
            add(make_sample(rng.choice(HEAVY_SUMMARIES), req, heavy_tier))
            add(make_sample(rng.choice(MID_SUMMARIES), req, mid_tier))
            add(make_sample(rng.choice(LIGHT_SUMMARIES), req, light_tier))

    # 2. Follow-ups consistent with a heavy/mid summary.
    for req in HEAVY_FOLLOWUPS:
        for _ in range(args.per_category // 8):
            add(make_sample(rng.choice(HEAVY_SUMMARIES), req, 3))
            add(make_sample(rng.choice(MID_SUMMARIES), req, 2))
    for req in MID_FOLLOWUPS:
        for _ in range(args.per_category // 8):
            add(make_sample(rng.choice(HEAVY_SUMMARIES), req, 2))
            add(make_sample(rng.choice(MID_SUMMARIES), req, 2))

    # 3. Light follow-ups stay light even under a heavy summary — the
    # classifier must read the REQUEST, not just the summary tone.
    for req in LIGHT_FOLLOWUPS:
        for _ in range(args.per_category // 8):
            add(make_sample(rng.choice(HEAVY_SUMMARIES), req, 0))
            add(make_sample(rng.choice(LIGHT_SUMMARIES), req, 0))

    # 4. Fresh-task requests inside an unrelated session: the request itself
    #    dominates, summary only adds mild context (cap at the request tier).
    fresh_tasks = [
        ("帮我写一个快速排序的 Rust 实现", 2),
        ("write a Rust quicksort implementation", 2),
        ("这个报错是什么意思：{}", 2),
        ("what does this error mean: {}", 2),
        ("现在几点了？", 0),
        ("what time is it?", 0),
        ("把这句话翻译成英文：{}", 1),
        ("translate this sentence to English: {}", 1),
        ("总结一下这篇文章", 1),
        ("summarize this article", 1),
        ("分析一下这个方案的性能瓶颈", 3),
        ("analyze the performance bottlenecks of this design", 3),
    ]
    for req_tpl, tier in fresh_tasks:
        for _ in range(args.per_category // 8):
            filled = req_tpl.format(
                rng.choice(["CUDA error 700", "borrow of moved value",
                            "connection refused", "segmentation fault",
                            "ECONNRESET at fetch", "类型不匹配错误"])
                if "{}" in req_tpl else ""
            )
            for pool, cap in ((HEAVY_SUMMARIES, tier), (MID_SUMMARIES, tier),
                              (LIGHT_SUMMARIES, max(0, tier - 1))):
                add(make_sample(rng.choice(pool), filled, cap))

    rng.shuffle(samples)
    out = Path(__file__).parent / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    tiers = [s["tier"] for s in samples]
    print(f"[context-augment] wrote {len(samples)} samples -> {out}")
    print(f"[context-augment] tier distribution: "
          f"R0={tiers.count(0)} R1={tiers.count(1)} R2={tiers.count(2)} R3={tiers.count(3)}")


if __name__ == "__main__":
    main()

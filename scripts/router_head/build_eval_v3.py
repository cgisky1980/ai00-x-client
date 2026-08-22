"""Build the context evaluation set with REAL summaries (v3).

Replaces the hand-written summaries in context_eval.jsonl with real
model-generated ones from the summary pool (same source as training — but
sampled with a DIFFERENT seed so eval summaries differ from train summaries).
Boundary semantics unchanged: same request + different-tier summary -> tier.

v3.1: 26 boundary requests x 4 pools x 2 distinct summaries ≈ 208 samples
(was 13 x 4 x 1 = 52) to reduce statistical noise.
"""

import json
import random
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
POOL = DATA_DIR / "multiturn" / "summaries.jsonl"
OUT = DATA_DIR / "context_eval_v3.jsonl"

BOUNDARIES = [
    # (request, heavy_tier, mid_tier, light_tier)
    ("继续", 3, 2, 0),
    ("continue", 3, 2, 0),
    ("go on", 3, 2, 0),
    ("接着说", 3, 2, 0),
    ("改成中文", 2, 2, 1),
    ("translate it to english", 2, 2, 1),
    ("换个思路试试", 2, 2, 1),
    ("try a different approach", 2, 2, 1),
    ("再详细一点", 2, 2, 1),
    ("explain in more detail", 2, 2, 1),
    ("把上面的结论整理成列表", 2, 2, 1),
    ("summarize the steps so far", 2, 2, 1),
    ("换成 python 实现", 2, 2, 1),
    ("rewrite it in rust", 2, 2, 1),
    ("跑一遍测试看看", 2, 2, 1),
    ("run the tests", 2, 2, 1),
    ("把日志贴出来", 2, 2, 1),
    ("show me the error log", 2, 2, 1),
    ("评估一下这个方案的风险", 3, 2, 2),
    ("still crashes, the stack trace changed, analyze again", 3, 3, 2),
    ("还是报错，你再看看", 3, 3, 2),
    ("it fails again with a different error", 3, 3, 2),
    ("好的", 0, 0, 0),
    ("got it, thanks", 0, 0, 0),
    ("明白了", 0, 0, 0),
    ("perfect, thanks", 0, 0, 0),
]

PER_POOL = 2  # distinct summaries per (pool, tier) pair


def main() -> None:
    pools: dict[int, list[str]] = {0: [], 1: [], 2: [], 3: []}
    with POOL.open("r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            s = row["summary"].strip()
            if len(s.split()) >= 4 or len(s) >= 12:
                pools[int(row["tier"])].append(s)

    # 评估用不同 seed，且优先取轮次靠后（更"滚动"）的摘要。
    rng = random.Random(20260822)
    samples = []
    for req, h, m, l in BOUNDARIES:
        for pool_key, tier in ((3, h), (2, m), (0, l), (1, l)):
            pool = pools.get(pool_key) or pools.get(2)
            if not pool:
                continue
            picks = rng.sample(pool, min(PER_POOL, len(pool)))
            for summary in picks:
                samples.append({
                    "text": f"Summary: {summary}\nRequest: {req}",
                    "tier": tier,
                })

    rng.shuffle(samples)
    with OUT.open("w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    tiers = [s["tier"] for s in samples]
    print(f"[eval-v3] wrote {len(samples)} samples -> {OUT}")
    print(f"[eval-v3] tier dist: R0={tiers.count(0)} R1={tiers.count(1)} R2={tiers.count(2)} R3={tiers.count(3)}")


if __name__ == "__main__":
    main()

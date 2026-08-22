"""Build the v4 boundary stress evaluation set.

Same boundary semantics as v3 (same ambiguous follow-up + different-tier
summaries), but summaries come EXCLUSIVELY from eval-side scenarios
(build_dataset_v4.py's eval_summary_pools.json) — zero overlap with training.

Each sample carries prev_tier (the label of the turn the summary belongs to,
i.e. the tier the router routed last turn) — matching the v4 runtime contract.
"""

import json
import random
from collections import Counter
from pathlib import Path

DATA = Path(__file__).parent / "data"
POOL = DATA / "multiturn" / "eval_summary_pools.json"
OUT = DATA / "boundary_eval_v4.jsonl"

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
    pools: dict[str, list[str]] = json.loads(POOL.read_text(encoding="utf-8"))
    pools = {int(k): v for k, v in pools.items()}
    rng = random.Random(20260824)

    samples = []
    for req, h, m, l in BOUNDARIES:
        # (summary_pool_key, expected_tier)：prev_tier = 摘要所属场景的背景 tier
        # （上一轮路由结果 ≈ 场景背景），与训练切片的 prev_tier 语义一致。
        for pool_key, tier in ((3, h), (2, m), (0, l), (1, l)):
            pool = pools.get(pool_key) or pools.get(2)
            if not pool:
                continue
            picks = rng.sample(pool, min(PER_POOL, len(pool)))
            for summary in picks:
                samples.append({
                    "text": f"Summary: {summary}\nRequest: {req}",
                    "tier": tier,
                    "prev_tier": pool_key,
                })

    rng.shuffle(samples)
    OUT.write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in samples) + "\n",
        encoding="utf-8",
    )
    tiers = [s["tier"] for s in samples]
    print(f"[eval-v4] wrote {len(samples)} samples -> {OUT}")
    print(f"[eval-v4] tier dist: R0={tiers.count(0)} R1={tiers.count(1)} "
          f"R2={tiers.count(2)} R3={tiers.count(3)}")
    print(f"[eval-v4] pools: { {k: len(v) for k, v in sorted(pools.items())} }")


if __name__ == "__main__":
    main()

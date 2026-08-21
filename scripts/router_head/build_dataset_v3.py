"""Build the v3 context-aware training dataset with REAL model-generated summaries.

Difference from build_dataset.py (v2, template summaries): the summary pool
comes from batch_summarize.rs — actual rwkv7-g1i-2.9b outputs using the
FROZEN production prompt/params/cleaning. Training distribution == runtime
distribution (same model, same prompt, same decoding).

Dataset composition (mirrors runtime):
  - golden_balanced.jsonl (16,751 real requests, human tiers)
  - ~70% paired with a REAL summary sampled from the tier-matched pool
    (tier label unchanged — same-complexity background)
  - ~30% kept bare (first-turn / summary-miss distribution)

Boundary samples ("继续" shifting tiers by context) are still produced by
gen_context_augment.py, which reads the same real-summary pools.
"""

import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def load_summary_pools() -> dict[int, list[str]]:
    """Real summaries from batch_summarize, grouped by scenario tier."""
    pools: dict[int, list[str]] = defaultdict(list)
    path = DATA_DIR / "multiturn" / "summaries.jsonl"
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            s = row["summary"].strip()
            # 过滤过短（退化）摘要：少于 4 词的没有任务信号。
            if len(s.split()) >= 4 or len(s) >= 12:
                pools[int(row["tier"])].append(s)
    return dict(pools)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", default=str(DATA_DIR / "golden_balanced.jsonl"))
    ap.add_argument("--out", default=str(DATA_DIR / "dataset_v3.jsonl"))
    ap.add_argument("--with-summary-ratio", type=float, default=0.7)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    pools = load_summary_pools()
    pool_stats = {f"R{t}": len(v) for t, v in sorted(pools.items())}
    print(f"[dataset-v3] real summary pools: {pool_stats}")
    total_pool = sum(len(v) for v in pools.values())
    if total_pool < 50:
        raise SystemExit(f"summary pool too small ({total_pool}); run batch_summarize first")

    # 池回退链：低档池不足时向上借（R0→R1→R2/R3；分类器要的是"背景基调"）。
    def pool_for(tier: int, rng: random.Random) -> str | None:
        chain = {0: [0, 1, 2, 3], 1: [1, 0, 2, 3], 2: [2, 1, 3, 0], 3: [3, 2, 1, 0]}[tier]
        for t in chain:
            if pools.get(t):
                return rng.choice(pools[t])
        return None

    rng = random.Random(args.seed)
    rows = []
    with Path(args.golden).open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    out_rows = []
    counts = {"bare": 0, "summary": 0, "fallback_pool": 0}
    for row in rows:
        tier = int(row["tier"])
        use_summary = rng.random() < args.with_summary_ratio
        summary = pool_for(tier, rng) if use_summary else None
        if use_summary and summary is None:
            use_summary = False
        if use_summary and summary is not None and tier not in pools:
            counts["fallback_pool"] += 1
        if use_summary and summary:
            out_rows.append({
                "text": f"Summary: {summary}\nRequest: {row['text']}",
                "tier": tier,
            })
            counts["summary"] += 1
        else:
            out_rows.append({"text": row["text"], "tier": tier})
            counts["bare"] += 1

    rng.shuffle(out_rows)
    out = Path(args.out)
    with out.open("w", encoding="utf-8") as f:
        for r in out_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    tiers = [r["tier"] for r in out_rows]
    print(f"[dataset-v3] wrote {len(out_rows)} samples -> {out}")
    print(f"[dataset-v3] format: {counts['summary']} real-summary / {counts['bare']} bare "
          f"({counts['summary'] / len(out_rows):.0%} summary)")
    if counts["fallback_pool"]:
        print(f"[dataset-v3] note: {counts['fallback_pool']} samples borrowed from adjacent tier pools")
    print(f"[dataset-v3] tier dist: R0={tiers.count(0)} R1={tiers.count(1)} R2={tiers.count(2)} R3={tiers.count(3)}")


if __name__ == "__main__":
    main()

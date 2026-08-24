"""NuminaMath-CoT -> R3 定向增强集（train-only，单轮裸请求形态）。

分档映射（按 source 标签构造难度梯度，防「数学=R3」捷径）：
  R3 = olympiads / amc_aime / aops_forum   （奥赛/证明题）
  R2 = cn_k12 / synthetic_amc              （中档题）
  R1 = gsm8k / orca_math / synthetic_math  （简单应用题）

过滤：len<=1500 chars；题干前 120 字符哈希去重；与现有 v5.3 train 文本去重。
输出：data/multiturn/numina_aug.jsonl（{text, tier}，无 prev_tier）。
"""

import hashlib
import json
import random
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

BASE = Path(__file__).parent
MT = BASE / "data" / "multiturn"
OUT = MT / "numina_aug.jsonl"

TIER_OF = {
    "olympiads": 3, "amc_aime": 3, "aops_forum": 3,
    "cn_k12": 2, "synthetic_amc": 2,
    "gsm8k": 1, "orca_math": 1, "synthetic_math": 1,
    "math": 2, "gaokao": 2, "orca": 1, "synthetic": 1,
}
# 每 tier 目标采样量
QUOTA = {3: 6000, 2: 3500, 1: 3000}
MAX_CHARS = 1500
SEED = 20260824


def seen_hashes() -> set[str]:
    """现有训练/评估文本的指纹（防重叠 + 防泄漏）。"""
    seen = set()
    for name in ["slices_v53_train", "slices_v53_eval", "slices_v53_eval_new"]:
        p = MT / f"{name}.jsonl"
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            t = json.loads(line)["text"]
            seen.add(hashlib.md5(t.strip()[:120].encode()).hexdigest())
    return seen


def main() -> None:
    rng = random.Random(SEED)
    seen = seen_hashes()
    print(f"existing text fingerprints: {len(seen)}")

    pools: dict[int, list[str]] = {1: [], 2: [], 3: []}
    internal: set[str] = set()
    for i in [0, 1]:
        p = hf_hub_download("AI-MO/NuminaMath-CoT", f"data/train-0000{i}-of-00005.parquet", repo_type="dataset")
        t = pq.read_table(p, columns=["problem", "source"])
        probs = t.column("problem").to_pylist()
        srcs = t.column("source").to_pylist()
        for prob, src in zip(probs, srcs):
            tier = TIER_OF.get(src)
            if tier is None:
                continue
            u = (prob or "").strip()
            if not 40 <= len(u) <= MAX_CHARS or "\n\n\n" in u:
                continue
            h = hashlib.md5(u[:120].encode()).hexdigest()
            if h in internal or h in seen:
                continue
            internal.add(h)
            pools[tier].append(u)
        print(f"shard {i}: pools -> { {k: len(v) for k, v in pools.items()} }")

    rows = []
    for tier, want in QUOTA.items():
        cand = pools[tier]
        rng.shuffle(cand)
        take = cand[:want]
        rows.extend({"text": t, "tier": tier} for t in take)
        print(f"R{tier}: {len(cand)} available -> sampled {len(take)}")
    rng.shuffle(rows)

    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} -> {OUT}")
    print(f"tier dist: {dict(sorted(Counter(r['tier'] for r in rows).items()))}")


if __name__ == "__main__":
    main()

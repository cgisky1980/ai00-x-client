"""Sample REAL multi-turn conversations into router scenarios (v2).

Sources (downloaded to data/multiturn/raw/):
  - ShareGPT-Chinese-English-90k (shareAI): real user-assistant chats,
    zh/en x (common/computer) — real assistant replies, wide scenario coverage.
  - lmsys/mt_bench_human_judgments parquet: MT-Bench Q&A pairs with strong
    model answers (gpt-3.5-turbo / gpt-4), 8 categories.

Output: scenarios_v2.jsonl — {"turns": [{"user","assistant"}], "tier": 0-3},
byte-compatible with batch_summarize.rs input. Tier assignment is heuristic:

  R0 chitchat:  short messages, daily-life keywords, no code
  R1 daily QA:  simple single-step tasks (advice, short writing, explanations)
  R2 pro task:  coding/implementation, long structured writing, extraction
  R3 deep debug/reasoning: error/traceback/leak keywords + multi-turn probing

Usage:
  uv run --with pyarrow python sample_scenarios_v2.py
  # second batch (bigger quotas, different seed, dedup vs batch 1):
  uv run --with pyarrow python sample_scenarios_v2.py \
    --out data/multiturn/scenarios_v2b.jsonl --seed 20260823 --scale 2 \
    --exclude data/multiturn/scenarios_v2.jsonl
"""

import argparse
import json
import random
import re
from pathlib import Path

DATA = Path(__file__).parent / "data" / "multiturn"
RAW = DATA / "raw"
OUT = DATA / "scenarios_v2.jsonl"

MAX_TURNS = 4          # legacy default for batch 1/2; v2c uses --max-turns 6
MAX_MSG_CHARS = 2000   # cap per message (prefill cost control)
MIN_FIRST_USER = 8     # skip empty/greeting-only conversations

# ---- quotas: (source, lang, tier) -> n scenarios ----
SHAREGPT_QUOTA = {
    ("common", "zh", 0): 15, ("common", "en", 0): 15,
    ("common", "zh", 1): 15, ("common", "en", 1): 15,
    ("computer", "zh", 2): 15, ("computer", "en", 2): 15,
    ("computer", "zh", 3): 12, ("computer", "en", 3): 12,
}
MTBENCH_PER_CATEGORY = 8
MTBENCH_TIER = {  # category -> tier
    "roleplay": 0, "writing": 1, "stem": 1, "humanities": 1,
    "math": 2, "coding": 2, "extraction": 2, "reasoning": 3,
}

CHITCHAT_ZH = re.compile(r"聊天|无聊|心情|开心|难过|陪我|讲个|笑话|晚安|早安|吃饭|玩|游戏|电影|音乐|喜欢|爱|朋友|放假|周末")
CHITCHAT_EN = re.compile(r"\b(chat|bored|feeling|joke|funny|weekend|hobby|movie|music|game|play|friend|love|miss)\b", re.I)
DEBUG_RE = re.compile(
    r"error|exception|traceback|stack ?trace|segmentation|segfault|core ?dump|"
    r"memory leak|deadlock|crash|\bbug\b|\bdebug\b|not working|doesn'?t work|fails?|"
    r"报错|错误|异常|崩溃|调试|失败|不工作|没用|无效|段错误|内存泄漏|死锁|修复",
    re.I,
)
CODE_RE = re.compile(r"```|\bdef \b|\bfunction\b|\bclass \w+|SELECT .* FROM|</?\w+>|=>|\{\s*\}")


def clean_msg(s: str) -> str:
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()[:MAX_MSG_CHARS]


def valid_turns(turns: list[dict], max_turns: int) -> bool:
    if not (2 <= len(turns) <= max_turns):
        return False
    if len(turns[0]["user"]) < MIN_FIRST_USER:
        return False
    return all(t["user"] and t["assistant"] for t in turns)


def sharegpt_tier(turns: list[dict], kind: str) -> int:
    full = "\n".join(t["user"] + "\n" + t["assistant"] for t in turns)
    avg_user = sum(len(t["user"]) for t in turns) / len(turns)
    has_code = bool(CODE_RE.search(full))
    if kind == "computer":
        n_debug = len(DEBUG_RE.findall(full))
        if n_debug >= 2 or (n_debug >= 1 and len(turns) >= 3):
            return 3
        return 2
    # common: no-code conversations
    if has_code:
        return 2
    if avg_user < 60 and (CHITCHAT_ZH.search(full) or CHITCHAT_EN.search(full)):
        return 0
    return 1


def load_exclude(path: Path | None) -> set[str]:
    """First-user texts of already-sampled scenarios (cross-batch dedup)."""
    excl: set[str] = set()
    if path and path.exists():
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                turns = row.get("turns") or []
                if turns:
                    excl.add(turns[0]["user"])
    return excl


def load_sharegpt(path: Path, kind: str, lang: str, quota: dict[tuple, int], rng: random.Random, excl: set[str], max_turns: int):
    """One pass, reservoir-ish: collect candidates per tier until quota filled."""
    buckets: dict[int, list[dict]] = {0: [], 1: [], 2: [], 3: []}
    seen = 0
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            conv = row.get("conversation") or []
            turns = []
            for pair in conv:
                u = clean_msg(str(pair.get("human") or ""))
                a = clean_msg(str(pair.get("assistant") or ""))
                if u or a:
                    turns.append({"user": u, "assistant": a})
            turns = turns[:max_turns]
            if not valid_turns(turns, max_turns):
                continue
            if turns[0]["user"] in excl:
                continue
            seen += 1
            tier = sharegpt_tier(turns, kind)
            buckets[tier].append({"turns": turns, "tier": tier, "source": f"sharegpt/{kind}_{lang}"})
            # early exit when all nonzero quotas for this file are filled (with margin)
            if all(
                len(buckets[t]) >= quota.get((kind, lang, t), 0) + 5
                for t in (0, 1, 2, 3)
                if quota.get((kind, lang, t), 0) > 0
            ):
                break
    out = []
    for t in (0, 1, 2, 3):
        need = quota.get((kind, lang, t), 0)
        pool = buckets[t]
        rng.shuffle(pool)
        out.extend(pool[:need])
        print(f"[sharegpt {kind}_{lang}] tier{t}: {len(pool)} candidates -> {min(need, len(pool))} sampled")
    return out


def load_mtbench(rng: random.Random, per_category: int, excl: set[str], max_turns: int):
    import pyarrow.parquet as pq

    qs = {}
    with (DATA / "mt_bench_questions.jsonl").open("r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            qs[int(row["question_id"])] = row
    t = pq.read_table(RAW / "mt_bench_human.parquet").to_pylist()
    # prefer strongest model answers, dedupe by question_id
    best: dict[int, list[dict]] = {}
    rank = {"gpt-4": 0, "gpt-3.5-turbo": 1}
    for row in t:
        qid = int(row["question_id"])
        for side in ("conversation_b", "conversation_a"):
            conv = row.get(side) or []
            model = row.get("model_b" if side == "conversation_b" else "model_a", "")
            if model not in rank:
                continue
            if qid in best and rank[model] >= rank[best[qid][0]]:
                continue
            turns = []
            for m in conv:
                role, content = m.get("role"), clean_msg(str(m.get("content") or ""))
                if not content:
                    continue
                if turns and turns[-1]["user"] and role == "assistant":
                    turns[-1]["assistant"] = content
                elif role == "user" and (not turns or turns[-1]["assistant"]):
                    turns.append({"user": content, "assistant": ""})
            turns = [x for x in turns if x["assistant"]][:max_turns]
            if valid_turns(turns, max_turns):
                best[qid] = (model, turns)
    by_cat: dict[str, list[dict]] = {}
    for qid, (model, turns) in best.items():
        if turns[0]["user"] in excl:
            continue
        cat = qs.get(qid, {}).get("category", "unknown")
        by_cat.setdefault(cat, []).append(
            {"turns": turns, "tier": MTBENCH_TIER.get(cat, 1), "source": f"mtbench/{cat}"})
    out = []
    for cat, pool in sorted(by_cat.items()):
        rng.shuffle(pool)
        take = pool[:per_category]
        out.extend(take)
        print(f"[mtbench {cat}] {len(pool)} -> {len(take)} (tier {MTBENCH_TIER.get(cat, 1)})")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--seed", type=int, default=20260821)
    ap.add_argument("--scale", type=float, default=1.0,
                    help="quota multiplier (more scenarios per bucket)")
    ap.add_argument("--exclude", nargs="+", default=None,
                    help="previous scenarios jsonl(s); skip conversations with the same first user msg")
    ap.add_argument("--max-turns", type=int, default=MAX_TURNS,
                    help="cap on turns per conversation (v2c uses 6 for deeper rolling summaries)")
    args = ap.parse_args()

    out_path = Path(args.out)
    quota = {k: int(v * args.scale) for k, v in SHAREGPT_QUOTA.items()}
    mtbench_per = max(1, int(MTBENCH_PER_CATEGORY * args.scale))
    excl: set[str] = set()
    if args.exclude:
        for p in args.exclude:
            excl |= load_exclude(Path(p))
    print(f"[sample] seed={args.seed} scale={args.scale} max_turns={args.max_turns} "
          f"exclude={len(excl)} first-user keys")

    rng = random.Random(args.seed)
    scenarios = []
    for (kind, lang), _paths in {
        ("common", "zh"): [RAW / "common_zh_70k.jsonl"],
        ("common", "en"): [RAW / "common_en_70k.jsonl"],
        ("computer", "zh"): [RAW / "computer_zh_26k.jsonl"],
        ("computer", "en"): [RAW / "computer_en_26k.jsonl"],
    }.items():
        for p in _paths:
            if not p.exists():
                print(f"[warn] missing {p.name}, skipped")
                continue
            scenarios.extend(load_sharegpt(p, kind, lang, quota, rng, excl, args.max_turns))
    scenarios.extend(load_mtbench(rng, mtbench_per, excl, args.max_turns))

    rng.shuffle(scenarios)
    with out_path.open("w", encoding="utf-8") as f:
        for s in scenarios:
            f.write(json.dumps({"turns": s["turns"], "tier": s["tier"]}, ensure_ascii=False) + "\n")

    dist = {}
    turns_dist = {}
    for s in scenarios:
        dist[s["tier"]] = dist.get(s["tier"], 0) + 1
        turns_dist[len(s["turns"])] = turns_dist.get(len(s["turns"]), 0) + 1
    est = sum(len(s["turns"]) for s in scenarios)
    print(f"\nwrote {len(scenarios)} scenarios -> {out_path}")
    print(f"tier dist: {dict(sorted(dist.items()))}")
    print(f"turns dist: {dict(sorted(turns_dist.items()))}")
    print(f"estimated summaries (one per turn): {est}")


if __name__ == "__main__":
    main()

"""Merge raw summary pools with quality filtering.

Sources (RAW generations from batch_summarize.rs, one file per scenario batch):
  - summaries.v1.bak.jsonl  : original pool (232 raw, hand-built scenarios)
  - summaries_v2.jsonl      : batch 1 (ShareGPT zh/en + MT-Bench, 178 scenarios)
  - summaries_v2b.jsonl     : batch 2 (scale-2 sampling, 244 scenarios)
Output overwrites data/multiturn/summaries.jsonl (the pool consumed by
build_dataset_v3 / gen_context_augment / build_eval_v3).

Filters (degenerate generations from the 2.9B summarizer on real chats):
  - too short: <30 chars or <6 words -> no signal for the router head
  - garbled: exotic-symbol density (e.g. "✿end33✿" tokenizer corruption)
"""

import json
from collections import Counter
from pathlib import Path

DATA = Path(__file__).parent / "data" / "multiturn"
SOURCES = [
    DATA / "summaries.v1.bak.jsonl",
    DATA / "summaries_v2.jsonl",
    DATA / "summaries_v2b.jsonl",
]
OUT = DATA / "summaries.jsonl"


def ok(s: str) -> bool:
    if len(s) < 30 or len(s.split()) < 6:
        return False
    weird = sum(1 for c in s if 0x2500 <= ord(c) <= 0x27BF or 0x1F000 <= ord(c) <= 0x1FAFF)
    if weird >= 2 or weird / max(len(s), 1) > 0.02:
        return False
    return True


def main():
    kept, dropped = [], 0
    seen = set()
    for src in SOURCES:
        if not src.exists():
            print(f"[merge] warn: missing {src.name}, skipped")
            continue
        n_src = 0
        with src.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                n_src += 1
                s = row["summary"].strip()
                key = s.lower()
                if key in seen or not ok(s):
                    dropped += 1
                    continue
                seen.add(key)
                kept.append({"summary": s, "tier": int(row["tier"]), "turn": int(row.get("turn", 0))})
        print(f"[merge] {src.name}: {n_src} raw")
    with OUT.open("w", encoding="utf-8") as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"[merge] kept {len(kept)}, dropped {dropped} -> {OUT}")
    print(f"[merge] tier dist: {dict(sorted(Counter(r['tier'] for r in kept).items()))}")


if __name__ == "__main__":
    main()

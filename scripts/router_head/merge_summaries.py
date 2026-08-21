"""Merge old + v2 summary pools with quality filtering.

Filters (degenerate generations from the 2.9B summarizer on real chats):
  - too short: <30 chars or <6 words -> no signal for the router head
  - garbled: exotic-symbol density >4% (e.g. "✿end33✿" tokenizer corruption)
Output overwrites data/multiturn/summaries.jsonl (old pool -> .v1.bak).
"""

import json
import shutil
from collections import Counter
from pathlib import Path

DATA = Path(__file__).parent / "data" / "multiturn"
SOURCES = [DATA / "summaries.jsonl", DATA / "summaries_v2.jsonl"]
OUT = DATA / "summaries.jsonl"


def ok(s: str) -> bool:
    if len(s) < 30 or len(s.split()) < 6:
        return False
    exotic = sum(1 for c in s if ord(c) > 0x2E80 or (0x2500 <= ord(c) <= 0x27BF))
    # CJK is expected; exotic = box-drawing/dingbats/symbols beyond CJK
    weird = sum(1 for c in s if 0x2500 <= ord(c) <= 0x27BF or 0x1F000 <= ord(c) <= 0x1FAFF)
    if weird >= 2 or weird / max(len(s), 1) > 0.02:
        return False
    if exotic / max(len(s), 1) > 0.6:  # almost no CJK but claimed zh? still fine, skip
        pass
    return True


def main():
    shutil.copy2(OUT, DATA / "summaries.v1.bak.jsonl")
    kept, dropped = [], 0
    seen = set()
    for src in SOURCES:
        if src == OUT:
            src = DATA / "summaries.v1.bak.jsonl"
        with src.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                s = row["summary"].strip()
                key = s.lower()
                if key in seen or not ok(s):
                    dropped += 1
                    continue
                seen.add(key)
                kept.append({"summary": s, "tier": int(row["tier"]), "turn": int(row.get("turn", 0))})
    with OUT.open("w", encoding="utf-8") as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"kept {len(kept)}, dropped {dropped}")
    print("tier dist:", dict(sorted(Counter(r['tier'] for r in kept).items())))
    print(f"backup -> {DATA / 'summaries.v1.bak.jsonl'}")


if __name__ == "__main__":
    main()

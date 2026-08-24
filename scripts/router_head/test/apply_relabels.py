"""应用 R1/R2 争议样本复核标签 -> *_rl_features.jsonl（tier 修正版 eval）。"""

import json
from pathlib import Path

BASE = Path(__file__).parent.parent

JOBS = [
    ("test/relabel_eval_out.json", "data/slices_v53_eval_features.jsonl", "data/slices_v53_eval_rl_features.jsonl"),
    ("test/relabel_evalnew_out.json", "data/slices_v53_eval_new_features.jsonl", "data/slices_v53_eval_new_rl_features.jsonl"),
]

for rel_p, feat_p, out_p in JOBS:
    rel = json.loads((BASE / rel_p).read_text(encoding="utf-8"))
    feats = [json.loads(l) for l in (BASE / feat_p).read_text(encoding="utf-8").splitlines() if l.strip()]
    changed = 0
    dist: dict[str, int] = {}
    for k, v in rel.items():
        i = int(k)
        new = int(v)
        if feats[i]["tier"] != new:
            feats[i]["tier"] = new
            changed += 1
        dist[str(new)] = dist.get(str(new), 0) + 1
    (BASE / out_p).write_text("\n".join(json.dumps(r) for r in feats) + "\n", encoding="utf-8")
    print(f"{Path(rel_p).name}: {len(rel)} reviewed, changed {changed} ({changed / len(rel):.0%}), "
          f"new dist {dict(sorted(dist.items()))} -> {out_p}")

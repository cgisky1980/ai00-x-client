"""导出 eval/eval_new 中 R1↔R2 争议样本（真值∈{1,2} 且模型预测≠真值）供复核。

产出 test/relabel_eval.txt / test/relabel_evalnew.txt（IDX 行 + prev + Summary/Request）。
"""

import json
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).parent.parent
LN_EPS = 1e-5


def predict(head, rows):
    X = np.stack([np.asarray(r["hidden"], dtype=np.float32) for r in rows])
    prevs = [r.get("prev_tier") for r in rows]
    n = len(rows)
    oh = np.zeros((n, 5), dtype=np.float32)
    for i, p in enumerate(prevs):
        oh[i, p if p is not None and p < 4 else 4] = 1.0
    X = np.concatenate([X, oh], axis=1)
    xn = (X - np.asarray(head["mean"], dtype=np.float32)) / np.maximum(np.asarray(head["std"], dtype=np.float32), 1e-6)
    w1 = np.asarray(head["w1"], dtype=np.float32).reshape(head["hidden_dim"], head["input_dim"])
    z = xn @ w1.T + np.asarray(head["b1"], dtype=np.float32)
    z = 0.5 * z * (1 + np.tanh(0.7978846 * (z + 0.044715 * z**3)))
    mu = z.mean(-1, keepdims=True)
    var = z.var(-1, keepdims=True)
    zn = (z - mu) / np.sqrt(var + LN_EPS) * np.asarray(head["ln_g"], dtype=np.float32) + np.asarray(head["ln_b"], dtype=np.float32)
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, head["hidden_dim"])
    return (zn @ w2.T + np.asarray(head["b2"], dtype=np.float32)).argmax(1)


def main():
    head = json.loads((BASE / "router_head_v55hw.json").read_text(encoding="utf-8"))
    jobs = [
        ("data/slices_v53_eval_features.jsonl", "data/multiturn/slices_v53_eval.jsonl", "test/relabel_eval.txt"),
        ("data/slices_v53_eval_new_features.jsonl", "data/multiturn/slices_v53_eval_new.jsonl", "test/relabel_evalnew.txt"),
    ]
    for feat_p, slice_p, out_p in jobs:
        feats = [json.loads(l) for l in (BASE / feat_p).read_text(encoding="utf-8").splitlines() if l.strip()]
        slices = [json.loads(l) for l in (BASE / slice_p).read_text(encoding="utf-8").splitlines() if l.strip()]
        pred = predict(head, feats)
        lines = []
        n = 0
        for i, (f, s) in enumerate(zip(feats, slices)):
            if f["tier"] not in (1, 2) or pred[i] == f["tier"]:
                continue
            n += 1
            t = s["text"]
            if "\nRequest: " in t:
                summ, req = t.split("\nRequest: ", 1)
                summ = summ[len("Summary: "):]
            else:
                summ, req = "(首轮无摘要)", t
            lines.append(f"IDX {i} prev={f.get('prev_tier')}\n  Summary: {summ[:300]}\n  Request: {req}")
        (BASE / out_p).write_text("\n".join(lines), encoding="utf-8")
        print(f"{out_p}: {n} disputed samples")


if __name__ == "__main__":
    main()

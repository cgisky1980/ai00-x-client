"""head 诊断：任意 features 上混淆矩阵 + 过度/不足配比 + 预测分布。

用法：
  uv run test/diag_head.py router_head_v53g.json data/slices_v53_eval_features.jsonl [text.jsonl]
"""

import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

LN_EPS = 1e-5


def gelu(x):
    return 0.5 * x * (1.0 + np.tanh(0.797_884_6 * (x + 0.044_715 * x**3)))


def predict(head, rows):
    X = np.stack([np.asarray(r["hidden"], dtype=np.float32) for r in rows])
    prevs = [r.get("prev_tier") for r in rows]
    n = len(rows)
    onehot = np.zeros((n, 5), dtype=np.float32)
    for i, p in enumerate(prevs):
        onehot[i, p if p is not None and p < 4 else 4] = 1.0
    X = np.concatenate([X, onehot], axis=1)
    xn = (X - np.asarray(head["mean"], dtype=np.float32)) / np.maximum(np.asarray(head["std"], dtype=np.float32), 1e-6)
    w1 = np.asarray(head["w1"], dtype=np.float32).reshape(head["hidden_dim"], head["input_dim"])
    z = gelu(xn @ w1.T + np.asarray(head["b1"], dtype=np.float32))
    mu = z.mean(axis=-1, keepdims=True)
    var = z.var(axis=-1, keepdims=True)
    zn = (z - mu) / np.sqrt(var + LN_EPS) * np.asarray(head["ln_g"], dtype=np.float32) + np.asarray(head["ln_b"], dtype=np.float32)
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, head["hidden_dim"])
    return (zn @ w2.T + np.asarray(head["b2"], dtype=np.float32)).argmax(axis=1)


def main():
    head_p, feat_p = sys.argv[1], sys.argv[2]
    head = json.loads(Path(head_p).read_text(encoding="utf-8"))
    rows = [json.loads(l) for l in Path(feat_p).read_text(encoding="utf-8").splitlines() if l.strip()]
    pred = predict(head, rows)
    y = np.asarray([r["tier"] for r in rows])
    cm = np.zeros((4, 4), dtype=int)
    for t, p in zip(y, pred):
        cm[t, p] += 1
    n = len(y)
    acc = (pred == y).mean()
    over = int(sum(1 for t, p in zip(y, pred) if p > t))
    under = int(sum(1 for t, p in zip(y, pred) if p < t))
    print(f"\n### {Path(head_p).name} on {Path(feat_p).name}: n={n} acc={acc:.4f}")
    print(f"over-provision (pred>true): {over} ({over/n:.1%}) | under: {under} ({under/n:.1%})")
    print("        " + "".join(f"pred=R{c:<7}" for c in range(4)))
    for t in range(4):
        tot = cm[t].sum()
        print(f"true=R{t} " + "".join(f"{cm[t, c]:<10}" for c in range(4)) + f" recall={cm[t, t]/max(tot,1):.2f}")
    print("pred dist:", dict(sorted(Counter(int(p) for p in pred).items())),
          "| true dist:", dict(sorted(Counter(int(t) for t in y).items())))
    # bare / ctx 分开
    for name, mask in [("bare", np.array([r.get("prev_tier") is None for r in rows])),
                       ("ctx", np.array([r.get("prev_tier") is not None for r in rows]))]:
        if mask.any():
            print(f"  {name}: n={int(mask.sum())} acc={(pred[mask] == y[mask]).mean():.4f}")
    # 错误样本（需文本文件：切片 jsonl 同序）
    if len(sys.argv) > 3:
        tr = [json.loads(l) for l in Path(sys.argv[3]).read_text(encoding="utf-8").splitlines() if l.strip()]
        wrong = np.where(pred != y)[0]
        rng = np.random.default_rng(0)
        pick = rng.choice(wrong, size=min(12, len(wrong)), replace=False) if len(wrong) else []
        print(f"  -- {len(wrong)} errors, sampled:")
        for i in sorted(pick):
            u = (tr[i]["text"].split("\nRequest: ")[-1])[:70].replace("\n", " ")
            print(f"   true=R{y[i]} pred=R{pred[i]} prev={rows[i].get('prev_tier')} {u!r}")


if __name__ == "__main__":
    main()

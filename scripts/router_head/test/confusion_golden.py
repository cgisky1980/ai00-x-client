"""混淆矩阵诊断：某 head 在 golden 裸文本集上与 golden 标签的分歧结构。"""

import json
import sys
from pathlib import Path

import numpy as np

LN_EPS = 1e-5


def gelu(x):
    return 0.5 * x * (1.0 + np.tanh(0.797_884_6 * (x + 0.044_715 * x**3)))


def main():
    head_p, feat_p = sys.argv[1], sys.argv[2]
    text_p = sys.argv[3] if len(sys.argv) > 3 else None
    head = json.loads(Path(head_p).read_text(encoding="utf-8"))
    H, y, texts = [], [], []
    text_rows = None
    if text_p:
        text_rows = [json.loads(l) for l in Path(text_p).read_text(encoding="utf-8").splitlines() if l.strip()]
    for i, line in enumerate(Path(feat_p).read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        r = json.loads(line)
        H.append(np.asarray(r["hidden"], dtype=np.float32))
        y.append(int(r["tier"]))
        src = text_rows[i] if text_rows and i < len(text_rows) else r
        texts.append((src.get("text") or "")[:90].replace("\n", " "))
    X = np.stack(H)
    y = np.asarray(y)
    n = len(y)
    onehot = np.zeros((n, 5), dtype=np.float32)
    onehot[:, 4] = 1.0
    X = np.concatenate([X, onehot], axis=1)
    xn = (X - np.asarray(head["mean"], dtype=np.float32)) / np.maximum(np.asarray(head["std"], dtype=np.float32), 1e-6)
    w1 = np.asarray(head["w1"], dtype=np.float32).reshape(head["hidden_dim"], head["input_dim"])
    z = gelu(xn @ w1.T + np.asarray(head["b1"], dtype=np.float32))
    mu = z.mean(axis=-1, keepdims=True)
    var = z.var(axis=-1, keepdims=True)
    zn = (z - mu) / np.sqrt(var + LN_EPS) * np.asarray(head["ln_g"], dtype=np.float32) + np.asarray(head["ln_b"], dtype=np.float32)
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, head["hidden_dim"])
    pred = (zn @ w2.T + np.asarray(head["b2"], dtype=np.float32)).argmax(axis=1)

    cm = np.zeros((4, 4), dtype=int)
    for t, p in zip(y, pred):
        cm[t, p] += 1
    print(f"{head_p} on {feat_p}  (rows=golden tier, cols=pred)")
    print("      " + "".join(f"pred=R{c:<6}" for c in range(4)))
    for t in range(4):
        print(f"true=R{t} " + "".join(f"{cm[t, c]:<10}" for c in range(4)))
    for t, p in [(0, 1), (1, 0), (1, 2), (2, 1), (2, 3), (0, 2)]:
        idx = np.where((y == t) & (pred == p))[0][:6]
        if len(idx):
            print(f"\n-- golden R{t} -> pred R{p} ({cm[t, p]} rows) examples:")
            for i in idx:
                print(f"   {texts[i]!r}")


if __name__ == "__main__":
    main()

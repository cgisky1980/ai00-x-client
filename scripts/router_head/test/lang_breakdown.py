"""按语言拆分统计 head 在人工 eval 上的分档召回（临时诊断）。"""

import json
import re
import sys
from collections import defaultdict

import numpy as np


def predict(head_p: str, feat_p: str):
    head = json.loads(open(head_p, encoding="utf-8").read())
    rows = [json.loads(l) for l in open(feat_p, encoding="utf-8") if l.strip()]
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
    zn = (z - mu) / np.sqrt(var + 1e-5) * np.asarray(head["ln_g"], dtype=np.float32) + np.asarray(head["ln_b"], dtype=np.float32)
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, head["hidden_dim"])
    return (zn @ w2.T + np.asarray(head["b2"], dtype=np.float32)).argmax(1)


def main():
    head_p, feat_p, slice_p = sys.argv[1], sys.argv[2], sys.argv[3]
    pred = predict(head_p, feat_p)
    feats = [json.loads(l) for l in open(feat_p, encoding="utf-8") if l.strip()]
    slices = [json.loads(l) for l in open(slice_p, encoding="utf-8") if l.strip()]
    zh = re.compile(r"[\u4e00-\u9fff]")
    stat = defaultdict(lambda: defaultdict(lambda: [0, 0]))  # lang -> tier -> [ok, n]
    for i, (f, s) in enumerate(zip(feats, slices)):
        y = f["tier"]
        p = int(pred[i])
        t = s["text"]
        iszh = len(zh.findall(t)) > len(t) * 0.15
        lang = "zh" if iszh else "en"
        d = stat[lang][y]
        d[0] += y == p
        d[1] += 1
    print(f"### {head_p} on {feat_p} by language")
    for lang in sorted(stat):
        parts = []
        tot_ok = tot_n = 0
        for tier in range(4):
            ok, n = stat[lang][tier]
            parts.append(f"R{tier} {ok}/{n}={ok / max(n, 1):.0%}")
            tot_ok += ok
            tot_n += n
        print(f"{lang}: n={tot_n} acc={tot_ok / tot_n:.1%} | " + " ".join(parts))


if __name__ == "__main__":
    main()

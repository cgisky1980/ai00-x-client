"""Evaluate an exported router_head.json on a features file.

Replicates the Rust RouterHead.forward math exactly (standardize -> Linear
-> GELU(tanh) -> LayerNorm -> Linear -> argmax) so the score matches the
deployed engine. Usage:

    uv run eval_head.py --head router_head.json --features data/context_eval_features.jsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

LN_EPS = 1e-5


def gelu(x: np.ndarray) -> np.ndarray:
    return 0.5 * x * (1.0 + np.tanh(0.797_884_6 * (x + 0.044_715 * x**3)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--head", default="router_head.json")
    ap.add_argument("--features", nargs="+", required=True)
    args = ap.parse_args()

    head = json.loads(Path(args.head).read_text(encoding="utf-8"))
    i_dim, h_dim = head["input_dim"], head["hidden_dim"]
    mean = np.asarray(head["mean"], dtype=np.float32)
    std = np.maximum(np.asarray(head["std"], dtype=np.float32), 1e-6)
    w1 = np.asarray(head["w1"], dtype=np.float32).reshape(h_dim, i_dim)
    b1 = np.asarray(head["b1"], dtype=np.float32)
    ln_g = np.asarray(head["ln_g"], dtype=np.float32)
    ln_b = np.asarray(head["ln_b"], dtype=np.float32)
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, h_dim)
    b2 = np.asarray(head["b2"], dtype=np.float32)

    for feats_path in args.features:
        hiddens, tiers, texts = [], [], []
        with Path(feats_path).open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                hiddens.append(np.asarray(row["hidden"], dtype=np.float32))
                tiers.append(int(row["tier"]))
                texts.append(row.get("text", ""))
        X = np.stack(hiddens)
        y = np.asarray(tiers)

        xn = (X - mean) / std
        z = gelu(xn @ w1.T + b1)
        mu = z.mean(axis=-1, keepdims=True)
        var = z.var(axis=-1, keepdims=True)
        zn = (z - mu) / np.sqrt(var + LN_EPS) * ln_g + ln_b
        logits = zn @ w2.T + b2
        pred = logits.argmax(axis=1)

        acc = float((pred == y).mean())
        print(f"\n{feats_path}: n={len(y)} acc={acc:.4f} ({int((pred == y).sum())}/{len(y)})")
        wrong = np.where(pred != y)[0]
        for i in wrong:
            req = texts[i].split("\nRequest: ")[-1][:40] if texts else ""
            print(f"  miss #{i}: tier={y[i]} pred={pred[i]} req={req!r}")
        print("  per-class:",
              {f"R{c}": f"{int(((pred == y) & (y == c)).sum())}/{int((y == c).sum())}"
               for c in range(4) if int((y == c).sum())})


if __name__ == "__main__":
    main()

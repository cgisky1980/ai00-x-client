"""v55hw 全面错误分析：错误模式六维拆解 + 错例抽样。

用法：
  uv run test/error_analysis.py router_head_v55hw.json data/slices_v53_eval_features.jsonl data/multiturn/slices_v53_eval.jsonl
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

LN_EPS = 1e-5
CONFIRM_RE = re.compile(
    r"^(好的?|好呀|嗯+|哦+|明白|了解|知道了?|继续|接着说?|请继续|继续吧|再来|说下去|"
    r"ok|okay|got ?it|great|nice|good|thanks|thank you|cool|sure|yes|"
    r"go ?on|continue|next)[.!。!？?\s]*$",
    re.I,
)
DEIXIS_RE = re.compile(
    r"上面|上文|刚才|之前的|继续|接着|改成|换成|重写|再来|重新|"
    r"the above|that one|this one|redo|rewrite|continue|elaborate",
    re.I,
)
ZH = re.compile(r"[\u4e00-\u9fff]")


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
    head_p, feat_p, slice_p = sys.argv[1], sys.argv[2], sys.argv[3]
    head = json.loads(Path(head_p).read_text(encoding="utf-8"))
    feats = [json.loads(l) for l in Path(feat_p).read_text(encoding="utf-8").splitlines() if l.strip()]
    slices = [json.loads(l) for l in Path(slice_p).read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(feats) == len(slices)
    pred = predict(head, feats)
    y = np.asarray([r["tier"] for r in feats])

    print(f"##### {Path(head_p).name} x {Path(feat_p).name}: n={len(y)} acc={(pred == y).mean():.4f}")

    # ---- 1. 混淆矩阵 ----
    cm = np.zeros((4, 4), dtype=int)
    for t, p in zip(y, pred):
        cm[t, p] += 1
    print("\n== 混淆矩阵 (行=真, 列=预测) ==")
    print("       " + "".join(f"pR{c:<7}" for c in range(4)))
    for t in range(4):
        print(f"tR{t}   " + "".join(f"{cm[t, c]:<9}" for c in range(4)) + f" recall={cm[t, t] / max(cm[t].sum(), 1):.2f}")

    wrong = np.where(pred != y)[0]
    over = sum(1 for i in wrong if pred[i] > y[i])
    under = len(wrong) - over
    print(f"\n== 错误方向 == 总错 {len(wrong)}: 过度配(高判) {over} ({over / len(wrong):.0%}) | 不足配(低判) {under} ({under / len(wrong):.0%})")
    for t in range(4):
        w = [i for i in wrong if y[i] == t]
        if not w:
            continue
        o = sum(1 for i in w if pred[i] > y[i])
        print(f"  true R{t}: 错 {len(w)} -> 高判 {o} / 低判 {len(w) - o} | 主要去向: " +
              ", ".join(f"R{p}({c})" for p, c in Counter(int(pred[i]) for i in w).most_common(2)))

    # ---- 2. 分组错误率 ----
    def group_stats(name, idxs):
        if not idxs:
            return
        n = len(idxs)
        w = sum(1 for i in idxs if pred[i] != y[i])
        print(f"  {name:24s} n={n:5d} err={w:4d} ({w / n:.1%})")

    print("\n== 分组错误率 ==")
    ctx = [i for i in range(len(y)) if feats[i].get("prev_tier") is not None]
    bare = [i for i in range(len(y)) if feats[i].get("prev_tier") is None]
    group_stats("带上下文(ctx)", ctx)
    group_stats("裸请求(bare)", bare)
    for pv in range(4):
        group_stats(f"  prev=R{pv}", [i for i in ctx if feats[i]["prev_tier"] == pv])

    # 继承类（确认/指代 且 label==prev）
    conf, conf_right = [], 0
    deix, deix_right = [], 0
    inherit_ok, inherit_n = 0, 0
    for i in range(len(y)):
        s = slices[i]
        user = s["text"].split("\nRequest: ")[-1]
        pt = feats[i].get("prev_tier")
        if pt is None:
            continue
        is_c = len(user) <= 24 and bool(CONFIRM_RE.match(user.strip()))
        is_d = len(user) <= 60 and bool(DEIXIS_RE.search(user))
        if is_c:
            conf.append(i)
            conf_right += y[i] == pt
        elif is_d:
            deix.append(i)
            deix_right += y[i] == pt
        if (is_c or is_d) and y[i] == pt:
            inherit_n += 1
            inherit_ok += pred[i] == y[i]
    group_stats("确认类(嗯/ok/继续)", conf)
    print(f"    其中标签==prev 比例: {conf_right}/{len(conf)} ({conf_right / max(len(conf), 1):.0%})")
    group_stats("指代类(改一下/上面)", deix)
    print(f"    其中标签==prev 比例: {deix_right}/{len(deix)} ({deix_right / max(len(deix), 1):.0%})")
    if inherit_n:
        print(f"  继承正确子集(标签=prev):  n={inherit_n} 模型跟对 {inherit_ok} ({inherit_ok / inherit_n:.1%})")

    zh_idx = [i for i in range(len(y)) if len(ZH.findall(slices[i]["text"])) > len(slices[i]["text"]) * 0.15]
    en_idx = [i for i in range(len(y)) if i not in set(zh_idx)]
    group_stats("中文", zh_idx)
    group_stats("英文", en_idx)

    # 长度桶（Request 部分）
    print("\n== 按请求长度 ==")
    buckets = [(0, 40), (40, 120), (120, 400), (400, 10**9)]
    for lo, hi in buckets:
        idxs = [i for i in range(len(y))
                if lo <= len(slices[i]["text"].split("\nRequest: ")[-1]) < hi]
        group_stats(f"len {lo}-{hi if hi < 10**6 else '+'}", idxs)

    # ---- 3. 错例抽样（每错误对 2 例） ----
    print("\n== 错例抽样 ==")
    for t in range(4):
        for p in range(4):
            if t == p or cm[t, p] < 25:
                continue
            idxs = [i for i in wrong if y[i] == t and pred[i] == p][:2]
            print(f"\n-- true R{t} -> pred R{p} ({cm[t, p]} 条):")
            for i in idxs:
                user = slices[i]["text"].split("\nRequest: ")[-1][:90].replace("\n", " ")
                print(f"   prev={feats[i].get('prev_tier')} {user!r}")


if __name__ == "__main__":
    main()

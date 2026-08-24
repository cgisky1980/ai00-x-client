"""v5.3：人工标注全链重打标——用 manual_labels.db 替代 v5.2 的 golden 兜底链。

v5.2 的标签链 = 规则优先 + golden(裸文本) 兜底；规则未覆盖处仍是模型预测，
自洽捷径与 boundary 崩塌未根治。v5.3 直接采用逐轮人工判级（10120 场景中
9921 个已全量人工标注，31879 轮），未标注场景（风险跳过 + 断点块）整场景
丢弃，不进入 train/eval。

与 v5.2 保持一致（仅标签来源变化，便于 A/B）：
  - 文本构造：turn-0 裸 user；turn k = Summary + Request（摘要过滤同 v5.2）
  - 划分：split_of(first_user)（train/eval），eval_new = gid >= 2123
  - prev_tier = 上一轮人工标签
  - 确认/指代继承类 train 侧 ×CONFIRM_BOOST 过采样（同 v5.2）

前置：data/multiturn/manual_labels.db（label_db.py 写入）+
slices_v5_*_features.jsonl（hidden 复用，行序 = v5 构建循环序）。

用法：
  uv run relabel_manual.py            # 产出 slices_v53_* + *_v53_features.jsonl
"""

import hashlib
import json
import re
import sqlite3
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent
DATA = BASE / "data"
MT = BASE / "data" / "multiturn"

SCEN = MT / "scenarios_all_v5.jsonl"
SUMM = MT / "summaries_v5_all.jsonl"
DB = MT / "manual_labels.db"

OLD_SCENARIO_COUNT = 2123
TRAIN_RATIO = 85
SPLIT_SEED = "v5"
MAX_USER_CHARS = 2000
CONFIRM_BOOST = 8

CONFIRM_RE = re.compile(
    r"^(好的?|好呀|嗯+|哦+|明白|了解|知道了?|继续|接着说?|请继续|继续吧|再来|说下去|"
    r"ok|okay|o\.?k\.?|got ?it|great|perfect|nice|good|thanks|thank you|cool|sure|yes|"
    r"go ?on|continue|next|keep going|please continue)[.!。!？?\s]*$",
    re.I,
)
DEIXIS_RE = re.compile(
    r"上面|上文|刚才|之前的|继续|接着|改成|换成|重写|再来|重新(写|做|生成)|"
    r"展开说说|详细说说|总结一下|整理一下|翻成|翻译成|照着|换一个|换个|"
    r"the above|that one|this one|redo it|rewrite it|continue|go on|elaborate|"
    r"summarize (that|this|the)|make it|turn it|convert it|change it|try another",
    re.I,
)
DEIXIS_MAX_CHARS = 60


def load_manual() -> dict[int, list[int]]:
    """gid -> [tier,...]（仅取全量标注场景）。"""
    con = sqlite3.connect(DB)
    rows = con.execute("SELECT gid, turn, tier FROM labels ORDER BY gid, turn").fetchall()
    con.close()
    by_gid: dict[int, dict[int, int]] = {}
    for g, t, tier in rows:
        by_gid.setdefault(g, {})[t] = tier
    return {g: [d[t] for t in sorted(d)] for g, d in by_gid.items()}


def summary_ok(s: str) -> bool:
    if len(s) < 30 or len(s.split()) < 6:
        return False
    weird = sum(1 for c in s if 0x2500 <= ord(c) <= 0x27BF or 0x1F000 <= ord(c) <= 0x1FAFF)
    if not (weird < 2 and weird / max(len(s), 1) <= 0.02):
        return False
    head = s.lstrip()[:24]
    if head.startswith("(none)") or head.startswith("Response to") or head.startswith("User:"):
        return False
    if "\nUser:" in s or "\nRequest:" in s or "\nQuestion:" in s:
        return False
    return True


def split_of(first_user: str) -> str:
    h = int(hashlib.md5((SPLIT_SEED + first_user).encode("utf-8")).hexdigest()[:8], 16) % 100
    return "train" if h < TRAIN_RATIO else "eval"


def main() -> None:
    manual = load_manual()

    scenarios = []
    for line in SCEN.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        scenarios.append((row["turns"], int(row["tier"])))

    kept = {g for g in manual if g < len(scenarios) and len(manual[g]) == len(scenarios[g][0])}
    print(f"[v5.3] manual full-labeled scenarios: {len(kept)}/{len(scenarios)}")

    sums: dict[tuple[int, int], str] = {}
    for line in SUMM.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        sums[(int(r["scenario"]), int(r["turn"]))] = r["summary"]

    def load_feats(path: Path) -> list:
        rows = {}
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                rows[r["idx"]] = r
        return [rows[i] for i in sorted(rows)]

    train_feats = load_feats(DATA / "slices_v5_train_features.jsonl")
    eval_feats = load_feats(DATA / "slices_v5_eval_features.jsonl")

    # v5.2 eval 切片（同序并行游标，eval 无 boost，可逐行对比标签变化）
    v52_eval = [json.loads(l) for l in (MT / "slices_v52_eval.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]

    out_train, out_eval, out_eval_new = [], [], []
    feats_train, feats_eval, feats_eval_new = [], [], []
    train_boost: list = []
    stats = Counter()
    feat_cursor = {"train": 0, "eval": 0}
    feats_by_side = {"train": train_feats, "eval": eval_feats}
    v52_cursor = 0
    changed_eval = 0

    for gid, (turns, _scenario_tier) in enumerate(scenarios):
        first_user = turns[0]["user"]
        side = split_of(first_user)
        is_new = gid >= OLD_SCENARIO_COUNT
        use = gid in kept
        if not use:
            stats[f"dropped_scen_{side}"] += 1
        labels = manual.get(gid, [])
        prev_label: int | None = None
        prev_summary: str | None = None
        for ti, turn in enumerate(turns):
            user = turn["user"][:MAX_USER_CHARS]
            summary = sums.get((gid, ti))
            sum_ok = summary is not None and summary_ok(summary)
            if ti == 0:
                text = user
            else:
                text = f"Summary: {prev_summary}\nRequest: {user}" if (sum_ok and prev_summary is not None) else user
            if sum_ok:
                prev_summary = summary

            if use:
                label = labels[ti]
                row = {"text": text, "tier": label, "prev_tier": prev_label}
                fr = feats_by_side[side][feat_cursor[side]]
                u = user.strip()
                is_inherit = (
                    ti > 0
                    and prev_label is not None
                    and label == prev_label
                    and (
                        (len(u) <= 24 and bool(CONFIRM_RE.match(u)))
                        or (len(u) <= DEIXIS_MAX_CHARS and bool(DEIXIS_RE.search(u)))
                    )
                )
                if side == "train":
                    out_train.append(row)
                    feats_train.append(fr)
                    if is_inherit:
                        for _ in range(CONFIRM_BOOST - 1):
                            train_boost.append((dict(row), fr))
                        stats["inherit_boost"] += CONFIRM_BOOST - 1
                else:
                    out_eval.append(row)
                    feats_eval.append(fr)
                    if v52_cursor < len(v52_eval):
                        if v52_eval[v52_cursor]["tier"] != label:
                            changed_eval += 1
                        v52_cursor += 1
                    if is_new:
                        out_eval_new.append(row)
                        feats_eval_new.append(fr)
                stats[f"kept_{side}"] += 1

            prev_label = labels[ti] if use else None
            feat_cursor[side] += 1

    print(f"[v5.3] label rows: kept train={stats['kept_train']} eval={stats['kept_eval']} | "
          f"dropped scen train={stats['dropped_scen_train']} eval={stats['dropped_scen_eval']} | "
          f"inherit boost +{stats['inherit_boost']}")
    print(f"[v5.3] eval tier changed vs v5.2: {changed_eval}/{len(out_eval)} ({changed_eval/max(len(out_eval),1):.1%})")

    boost_rows = [r for r, _ in train_boost]
    out_train_full = out_train + boost_rows
    train_feats_full = feats_train + [
        {"idx": 100000 + i, "tier": r["tier"], **({"prev_tier": r["prev_tier"]} if r["prev_tier"] is not None else {}), "hidden": fr["hidden"]}
        for i, (r, fr) in enumerate(train_boost)
    ]

    def write_slices(rows: list, path: Path) -> None:
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    write_slices(out_train_full, MT / "slices_v53_train.jsonl")
    write_slices(out_eval, MT / "slices_v53_eval.jsonl")
    write_slices(out_eval_new, MT / "slices_v53_eval_new.jsonl")

    def write_features(feats: list, slices: list, path: Path) -> None:
        assert len(feats) == len(slices)
        with path.open("w", encoding="utf-8") as f:
            for fr, sr in zip(feats, slices):
                out = {"idx": fr["idx"], "tier": sr["tier"]}
                if sr["prev_tier"] is not None:
                    out["prev_tier"] = sr["prev_tier"]
                out["hidden"] = fr["hidden"]
                f.write(json.dumps(out, ensure_ascii=False) + "\n")

    write_features(train_feats_full, out_train_full, DATA / "slices_v53_train_features.jsonl")
    write_features(feats_eval, out_eval, DATA / "slices_v53_eval_features.jsonl")
    write_features(feats_eval_new, out_eval_new, DATA / "slices_v53_eval_new_features.jsonl")

    print("[v5.3] wrote slices_v53_train/eval/eval_new + features (hidden reused)")
    print(f"[v5.3] train tier dist (incl boost): {dict(sorted(Counter(r['tier'] for r in out_train_full).items()))}")
    print(f"[v5.3] eval  tier dist: {dict(sorted(Counter(r['tier'] for r in out_eval).items()))}")


if __name__ == "__main__":
    main()

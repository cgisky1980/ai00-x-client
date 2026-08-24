"""v5.2：全链标签净化——用 golden 人工标注头重打标全部轮次。

v5.1 只修 turn-0，暴露出 turn k≥1 背景兜底标签（仍是场景配额噪声）才是
ctx 组 64.3% 的根因（v5 的 ctx 93.9% 实为 prev_tier=配额=标签的自洽捷径分，
见 参考/智能路由完成记录.md 第十三章）。

v5.2 全链重打标（标签链 = 文本复杂度 + 上下文继承，彻底去掉配额兜底）：
  turn-0:  golden(裸 user_0) 预测
  turn k:  1. 确认/短回应 → 继承上一轮 label（上下文语义核心，保留）
           2. 故障延续 → R3 / 3. computer+debug 关键词 → R3
           4. 代码/结构化 → R2 / 5. 短闲聊 → R0
           6. 其余 → golden(裸 user_k) 预测（替代场景配额兜底）
  prev_tier = 上一轮 label（新链）；摘要拼接/过滤逻辑不变（与标签无关）。

前置：all_users_v5.jsonl（全部轮次裸 user 文本）→ all_users_v5_features.jsonl
（extract_router_features BATCH=16）。

用法：
  uv run relabel_turn0.py            # 产出 slices_v52_* + *_v52_features.jsonl
"""

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

import numpy as np

BASE = Path(__file__).parent
DATA = BASE / "data"
MT = BASE / "data" / "multiturn"

SCEN = MT / "scenarios_all_v5.jsonl"
SUMM = MT / "summaries_v5_all.jsonl"
GOLDEN_HEAD = BASE / "router_head_golden.json"
ALL_USERS_FEATS = MT / "all_users_v5_features.jsonl"

OLD_SCENARIO_COUNT = 2123
TRAIN_RATIO = 85
SPLIT_SEED = "v5"
MAX_USER_CHARS = 2000

LN_EPS = 1e-5

CONFIRM_RE = re.compile(
    r"^(好的?|好呀|嗯+|哦+|明白|了解|知道了?|继续|接着说?|请继续|继续吧|再来|说下去|"
    r"ok|okay|o\.?k\.?|got ?it|great|perfect|nice|good|thanks|thank you|cool|sure|yes|"
    r"go ?on|continue|next|keep going|please continue)[.!。!？?\s]*$",
    re.I,
)
FAILURE_CONT_RE = re.compile(
    r"还是报错|还是不行|仍然|依然|还是失败|再次失败|换了?个错|不行了|"
    r"still (crash|fail|error|not work|broken)|fails? again|crash(es|ed)? again|"
    r"error changed|different error|stack ?trace changed|still not work",
    re.I,
)
DEBUG_RE = re.compile(
    r"error|exception|traceback|stack ?trace|segfault|crash|\bbug\b|\bdebug\b|"
    r"not working|fails?|报错|错误|异常|崩溃|调试|失败|修复|不行",
    re.I,
)
CODE_RE = re.compile(r"```|\bdef \b|\bfunction\b|SELECT .* FROM|</?\w+>|=>")
CHITCHAT_RE = re.compile(
    r"哈哈|嘻嘻|无聊|心情|开心|难过|讲个|笑话|晚安|早安|吃饭|好玩|游戏|电影|音乐|"
    r"\b(fun|joke|bored|weekend|hobby|movie|music)\b",
    re.I,
)
# 指代性请求：复杂度由上文对象决定（"改成中文"在上文 R3 代码任务里是 R2/R3
# 重写，在寒暄里是 R1 翻译）——裸文本 golden 打标对此类系统性错误（boundary
# 崩塌根因），继承上一轮标签才是正确语义（与线上 boundary 集设计一致）。
DEIXIS_RE = re.compile(
    r"上面|上文|刚才|之前的|继续|接着|改成|换成|重写|再来|重新(写|做|生成)|"
    r"展开说说|详细说说|总结一下|整理一下|翻成|翻译成|照着|换一个|换个|"
    r"the above|that one|this one|redo it|rewrite it|continue|go on|elaborate|"
    r"summarize (that|this|the)|make it|turn it|convert it|change it|try another",
    re.I,
)
DEIXIS_MAX_CHARS = 60


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


def rule_label(user: str, prev_label: int | None, is_computer: bool) -> int | None:
    """规则优先标签；返回 None = 无规则命中（交给 golden 兜底）。"""
    u = user.strip()
    if len(u) <= 24 and CONFIRM_RE.match(u):
        return prev_label  # 继承（None 仅 turn-0 且首句即确认——golden 兜底）
    if FAILURE_CONT_RE.search(u):
        return 3
    if is_computer and DEBUG_RE.search(u):
        return 3
    if CODE_RE.search(u):
        return 2
    if len(u) <= 60 and CHITCHAT_RE.search(u):
        return 0
    # 指代性请求（短 + 指代上文对象）→ 继承上一轮（复杂度由上文决定）。
    if prev_label is not None and len(u) <= DEIXIS_MAX_CHARS and DEIXIS_RE.search(u):
        return prev_label
    return None


def gelu(x: np.ndarray) -> np.ndarray:
    return 0.5 * x * (1.0 + np.tanh(0.797_884_6 * (x + 0.044_715 * x**3)))


def head_argmax(head: dict, hiddens: np.ndarray) -> np.ndarray:
    """golden 头批量 argmax（输入恒为 prev=None one-hot，裸文本形态）。"""
    n = hiddens.shape[0]
    onehot = np.zeros((n, 5), dtype=np.float32)
    onehot[:, 4] = 1.0
    X = np.concatenate([hiddens, onehot], axis=1)
    xn = (X - np.asarray(head["mean"], dtype=np.float32)) / np.maximum(
        np.asarray(head["std"], dtype=np.float32), 1e-6
    )
    w1 = np.asarray(head["w1"], dtype=np.float32).reshape(head["hidden_dim"], head["input_dim"])
    z = gelu(xn @ w1.T + np.asarray(head["b1"], dtype=np.float32))
    mu = z.mean(axis=-1, keepdims=True)
    var = z.var(axis=-1, keepdims=True)
    zn = (z - mu) / np.sqrt(var + LN_EPS) * np.asarray(head["ln_g"], dtype=np.float32) + np.asarray(
        head["ln_b"], dtype=np.float32
    )
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, head["hidden_dim"])
    return (zn @ w2.T + np.asarray(head["b2"], dtype=np.float32)).argmax(axis=1)


def split_of(first_user: str) -> str:
    h = int(hashlib.md5((SPLIT_SEED + first_user).encode("utf-8")).hexdigest()[:8], 16) % 100
    return "train" if h < TRAIN_RATIO else "eval"


def main() -> None:
    head = json.loads(GOLDEN_HEAD.read_text(encoding="utf-8"))

    # ---- 1. 场景 + 全部轮次裸文本 golden 预测（行序 = 场景序×轮次序）----
    scenarios = []
    for line in SCEN.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        scenarios.append((row["turns"], int(row["tier"])))

    preds_by_idx: list[int] = []
    with ALL_USERS_FEATS.open(encoding="utf-8") as f:
        hiddens = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            hiddens.append(np.asarray(r["hidden"], dtype=np.float32))
    n_expected = sum(len(t) for t, _ in scenarios)
    assert len(hiddens) == n_expected, f"features {len(hiddens)} != turns {n_expected}"
    preds_flat = head_argmax(head, np.stack(hiddens))

    # flat idx → (gid, ti) 映射
    golden_pred: dict[tuple[int, int], int] = {}
    k = 0
    for gid, (turns, _st) in enumerate(scenarios):
        for ti in range(len(turns)):
            golden_pred[(gid, ti)] = int(preds_flat[k])
            k += 1

    # ---- 2. 摘要（与标签无关，仅拼接用）----
    sums: dict[tuple[int, int], str] = {}
    for line in SUMM.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        sums[(int(r["scenario"]), int(r["turn"]))] = r["summary"]

    # ---- 3. v5 原切片特征（hidden 复用；行序 = build 循环序）----
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
    eval_new_feats = load_feats(DATA / "slices_v5_eval_new_features.jsonl")
    slices_train = [json.loads(l) for l in (MT / "slices_v5_train.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    slices_eval = [json.loads(l) for l in (MT / "slices_v5_eval.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    slices_eval_new = [json.loads(l) for l in (MT / "slices_v5_eval_new.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(train_feats) == len(slices_train)
    assert len(eval_feats) == len(slices_eval)
    assert len(eval_new_feats) == len(slices_eval_new)

    # ---- 4. 全链重建（规则优先 + golden 兜底 + 确认继承）----
    # 确认类样本 train 侧 ×CONFIRM_BOOST 过采样：golden 兜底样本（31k）教的是
    # 「看请求文本定档」，会淹没确认类的「跟随 prev_tier」信号（boundary 崩到
    # 随机的根因）；线上 sticky 只单向提升不降档，升档判断必须由模型承担。
    CONFIRM_BOOST = 8
    out_train, out_eval, out_eval_new = [], [], []
    train_boost: list[dict] = []  # (切片行, 对应 v5 特征行) —— 特征同步复制
    stats = Counter()
    # v5 特征行序遍历游标（train 侧）：确认行需要找到对应 hidden。
    feat_cursor = {"train": 0, "eval": 0}
    feats_by_side = {"train": train_feats, "eval": eval_feats}
    for gid, (turns, scenario_tier) in enumerate(scenarios):
        first_user = turns[0]["user"]
        is_computer = scenario_tier >= 2
        side = split_of(first_user)
        is_new = gid >= OLD_SCENARIO_COUNT
        prev_label: int | None = None
        prev_summary: str | None = None
        for ti, turn in enumerate(turns):
            user = turn["user"][:MAX_USER_CHARS]
            if ti == 0:
                label = golden_pred[(gid, 0)]
            else:
                rl = rule_label(user, prev_label, is_computer)
                label = rl if rl is not None else golden_pred[(gid, ti)]
            summary = sums.get((gid, ti))
            sum_ok = summary is not None and summary_ok(summary)
            if ti == 0:
                text = user
            else:
                text = f"Summary: {prev_summary}\nRequest: {user}" if (sum_ok and prev_summary is not None) else user
            row = {"text": text, "tier": label, "prev_tier": prev_label}
            # 继承类判定（确认 + 指代：标签=prev_label，需 boost 对抗 golden 兜底量级）。
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
                if is_inherit:
                    # boost 行追加到末尾（保持前段与 v5 行序对齐），特征同步收集。
                    fr = feats_by_side["train"][feat_cursor["train"]]
                    for _ in range(CONFIRM_BOOST - 1):
                        train_boost.append((dict(row), fr))
                    stats["confirm_boost"] += CONFIRM_BOOST - 1
                feat_cursor["train"] += 1
            else:
                out_eval.append(row)
                if is_new:
                    out_eval_new.append(row)
                feat_cursor["eval"] += 1
            stats["golden" if (ti == 0 or rule_label(user, prev_label, is_computer) is None) else "rule"] += 1
            if sum_ok:
                prev_summary = summary
            prev_label = label

    # 与 v5 标签对比（变化幅度；boost 行已追加在末尾，前段对齐）。
    ch = sum(1 for a, b in zip(slices_train, out_train) if a["tier"] != b["tier"])
    print(f"[v5.2] golden head relabeled ALL turns ({len(scenarios)} scenarios)")
    print(f"[v5.2] label source: {dict(stats)}")
    print(f"[v5.2] train tier changed vs v5: {ch}/{len(slices_train)} ({ch/len(slices_train):.1%})")

    # boost 行追加到切片与特征末尾（idx 偏移 100000 起，避免与原行冲突）。
    boost_rows = [r for r, _ in train_boost]
    out_train_full = out_train + boost_rows
    base_n = len(out_train)
    train_feats_full = train_feats + [
        {"idx": 100000 + i, "tier": r["tier"], **({"prev_tier": r["prev_tier"]} if r["prev_tier"] is not None else {}), "hidden": fr["hidden"]}
        for i, (r, fr) in enumerate(train_boost)
    ]
    print(f"[v5.2] confirm boost: +{len(boost_rows)} rows appended (train {base_n} -> {len(out_train_full)})")

    # ---- 5. 写出切片 + 特征（hidden 全复用）----
    def write_slices(rows: list, path: Path) -> None:
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    write_slices(out_train_full, MT / "slices_v52_train.jsonl")
    write_slices(out_eval, MT / "slices_v52_eval.jsonl")
    write_slices(out_eval_new, MT / "slices_v52_eval_new.jsonl")

    def write_features(feats: list, slices: list, path: Path) -> None:
        assert len(feats) == len(slices)
        with path.open("w", encoding="utf-8") as f:
            for fr, sr in zip(feats, slices):
                out = {"idx": fr["idx"], "tier": sr["tier"]}
                if sr["prev_tier"] is not None:
                    out["prev_tier"] = sr["prev_tier"]
                out["hidden"] = fr["hidden"]
                f.write(json.dumps(out, ensure_ascii=False) + "\n")

    write_features(train_feats_full, out_train_full, DATA / "slices_v52_train_features.jsonl")
    write_features(eval_feats, out_eval, DATA / "slices_v52_eval_features.jsonl")
    write_features(eval_new_feats, out_eval_new, DATA / "slices_v52_eval_new_features.jsonl")

    print("[v5.2] wrote slices_v52_train/eval/eval_new + features (hidden reused)")
    print(f"[v5.2] train tier dist (incl boost): {dict(sorted(Counter(r['tier'] for r in out_train_full).items()))}")
    print(f"[v5.2] eval  tier dist: {dict(sorted(Counter(r['tier'] for r in out_eval).items()))}")


if __name__ == "__main__":
    main()

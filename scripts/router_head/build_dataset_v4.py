"""Build the v4 context-aware training dataset: REAL per-turn conversation slices.

Core idea (replaces v3's random summary×request pairing — semantically incoherent):
one multiturn conversation yields one sample PER TURN, mirroring the runtime:

  turn 0: {text: user_0,                       prev_tier: None}   (bare, first turn)
  turn k: {text: "Summary: {sum_{k-1}}\\nRequest: {user_k}", prev_tier: label_{k-1}}

The rolling summary sum_{k-1} is the REAL batch_summarize output for turn k-1 of
the SAME conversation (train distribution == runtime distribution). When a
summary is rejected by the quality filter, the sample degrades to a bare
request + prev_tier (the runtime's summary-generation-failure distribution).

Per-turn tier labeling (heuristics, mirrors how a router should react):
  1. confirm/short ack ("继续"/"ok"/"got it")     -> inherit previous turn label
     (turn 0 inherits the scenario background tier) — THE context lesson
  2. failure continuation ("还是报错"/"still crashes") -> R3
  3. debug keywords in computer convos (>=1 hit)   -> R3
  4. code blocks / structured output request       -> R2
  5. short chit-chat message                       -> R0
  6. simple single-step QA                         -> R1
  7. otherwise                                     -> scenario background tier

Scenario-level 85/15 train/eval split by first-user-text hash — one conversation
never straddles the split (no leakage). Eval-side summaries are also dumped to
eval_summary_pools.json for build_eval_v4.py (boundary stress set).
"""

import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path(__file__).parent / "data" / "multiturn"
OUT_TRAIN = DATA / "multiturn_slices_train.jsonl"
OUT_EVAL = DATA / "multiturn_slices_eval.jsonl"
OUT_EVAL_POOLS = DATA / "eval_summary_pools.json"

# (scenarios file, raw summaries file) batches; scenario idx = line idx in file.
BATCHES = [
    ("scenarios.jsonl", "summaries.v1.bak.jsonl"),
    ("scenarios_v2.jsonl", "summaries_v2.jsonl"),
    ("scenarios_v2b.jsonl", "summaries_v2b.jsonl"),
    ("scenarios_v2c.jsonl", "summaries_v2c.jsonl"),
]

TRAIN_RATIO = 85  # hash % 100 < TRAIN_RATIO -> train

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

MAX_USER_CHARS = 2000


def summary_ok(s: str) -> bool:
    """与 merge_summaries.py 相同的质量过滤。"""
    if len(s) < 30 or len(s.split()) < 6:
        return False
    weird = sum(1 for c in s if 0x2500 <= ord(c) <= 0x27BF or 0x1F000 <= ord(c) <= 0x1FAFF)
    return weird < 2 and weird / max(len(s), 1) <= 0.02


def label_turn(user: str, prev_label: int | None, scenario_tier: int, is_computer: bool) -> int:
    u = user.strip()
    # 1. 纯确认/短回应 → 继承上一轮（turn 0 继承对话背景）。上下文决定含义。
    if len(u) <= 24 and CONFIRM_RE.match(u):
        return prev_label if prev_label is not None else scenario_tier
    # 2. 故障延续 → R3（无论背景）。
    if FAILURE_CONT_RE.search(u):
        return 3
    # 3. computer 对话中本轮带 debug 关键词 → R3。
    if is_computer and DEBUG_RE.search(u):
        return 3
    # 4. 明确代码/结构化产出 → R2。
    if CODE_RE.search(u):
        return 2
    # 5. 短消息 + 闲聊词 → R0。
    if len(u) <= 60 and CHITCHAT_RE.search(u):
        return 0
    # 6. 其余 → 对话背景 tier（默认；切片教的是上下文行为，弱信号不覆盖背景，
    #    bare 请求的档位判断由 golden 主数据集负责）。
    return scenario_tier


def load_batch(scen_path: Path, summ_path: Path):
    """返回 [(first_user, scenario_tier, [ {turn,summary} ])]（按生成器相同的行序）。"""
    scenarios = []
    for line in scen_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            # 与 batch_summarize 的跳过语义对齐（都跳过解析失败行，gid 索引一致）。
            continue
        scenarios.append((row["turns"], int(row["tier"])))
    sums: dict[tuple[int, int], str] = {}
    if summ_path.exists():
        for line in summ_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                # 生成进行中的文件尾部可能是半行（BufWriter flush 边界），跳过。
                continue
            sums[(int(r["scenario"]), int(r["turn"]))] = r["summary"]
    return scenarios, sums


def split_of(first_user: str) -> str:
    h = int(hashlib.md5(first_user.encode("utf-8")).hexdigest()[:8], 16) % 100
    return "train" if h < TRAIN_RATIO else "eval"


def main() -> None:
    train_rows, eval_rows = [], []
    eval_pools: dict[int, list[str]] = defaultdict(list)
    stats = Counter()

    for scen_name, summ_name in BATCHES:
        scen_path, summ_path = DATA / scen_name, DATA / summ_name
        if not scen_path.exists():
            print(f"[v4] warn: missing {scen_name}, skipped")
            continue
        scenarios, sums = load_batch(scen_path, summ_path)
        # computer 判定：v2+ 批次场景多为 sharegpt computer_* / mtbench coding。
        # v1 手构场景按 tier>=2 视作 computer 语境。
        n_scen = len(scenarios)
        for gid, (turns, scenario_tier) in enumerate(scenarios):
            first_user = turns[0]["user"]
            is_computer = scenario_tier >= 2
            side = split_of(first_user)
            prev_label: int | None = None
            prev_summary: str | None = None
            for ti, turn in enumerate(turns):
                user = turn["user"][:MAX_USER_CHARS]
                label = label_turn(user, prev_label, scenario_tier, is_computer)
                summary = sums.get((gid, ti))
                sum_ok = summary is not None and summary_ok(summary)
                if ti == 0:
                    text = user
                    row = {"text": text, "tier": label, "prev_tier": None}
                else:
                    if sum_ok and prev_summary is not None:
                        text = f"Summary: {prev_summary}\nRequest: {user}"
                    else:
                        # 摘要缺失/被过滤 → 裸请求 + prev_tier（线上失败分布）。
                        text = user
                    row = {"text": text, "tier": label, "prev_tier": prev_label}
                (train_rows if side == "train" else eval_rows).append(row)
                stats[side] += 1
                if row["prev_tier"] is not None:
                    stats[f"{side}_ctx"] += 1
                else:
                    stats[f"{side}_bare"] += 1
                # 滚动链：摘要被过滤时沿用更早的成功摘要（batch_summarize 同语义）。
                if sum_ok:
                    prev_summary = summary
                prev_label = label
                # eval 侧摘要池（boundary 压力评估用，与训练零重叠）。
                if side == "eval" and sum_ok:
                    eval_pools[scenario_tier].append(summary)
        print(f"[v4] {scen_name}: {n_scen} scenarios")

    OUT_TRAIN.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in train_rows) + "\n",
        encoding="utf-8",
    )
    OUT_EVAL.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in eval_rows) + "\n",
        encoding="utf-8",
    )
    OUT_EVAL_POOLS.write_text(
        json.dumps({str(k): v for k, v in sorted(eval_pools.items())}, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"[v4] train: {len(train_rows)} slices -> {OUT_TRAIN.name}")
    print(f"[v4] eval:  {len(eval_rows)} slices -> {OUT_EVAL.name}")
    print(f"[v4] stats: {dict(sorted(stats.items()))}")
    print(f"[v4] tier dist train: {dict(sorted(Counter(r['tier'] for r in train_rows).items()))}")
    print(f"[v4] tier dist eval:  {dict(sorted(Counter(r['tier'] for r in eval_rows).items()))}")
    print(f"[v4] eval pools: { {k: len(v) for k, v in sorted(eval_pools.items())} }")


if __name__ == "__main__":
    main()

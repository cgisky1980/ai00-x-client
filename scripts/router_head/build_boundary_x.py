"""boundary 压力集扩容：45 个新边界短语（原 40 条保持不动，纯增量）。

产出 boundary_eval_v5x.jsonl（~720 条）+ 可读 dump（供人工/子代理标注）。
tier 字段仍为短语映射猜测值（仅占位），正式标签由子代理逐条标注后回填。
"""

import json
import random
from pathlib import Path

DATA = Path(__file__).parent / "data"
POOL = DATA / "multiturn" / "eval_summary_pools_v5.json"
OUT = DATA / "boundary_eval_v5x.jsonl"
DUMP = DATA / "boundary_v5x_dump.txt"

# (request, heavy, mid, light) —— 新短语，风格对齐原 40 条
PHRASES = [
    ("嗯嗯", 0, 0, 0),
    ("ok 继续", 3, 2, 0),
    ("行", 0, 0, 0),
    ("great", 0, 0, 0),
    ("nice", 0, 0, 0),
    ("翻译成英文", 2, 2, 1),
    ("翻译成中文", 2, 2, 1),
    ("改成表格", 2, 2, 1),
    ("用中文回答", 2, 2, 1),
    ("make it shorter", 2, 2, 1),
    ("make it longer", 2, 2, 1),
    ("simplify it", 2, 2, 1),
    ("用 python 写", 2, 2, 1),
    ("explain like i'm five", 2, 2, 1),
    ("换成 json 格式", 2, 2, 1),
    ("加个异常处理", 3, 2, 2),
    ("支持并发吗", 3, 2, 2),
    ("性能有问题吗", 3, 2, 2),
    ("边界情况呢", 3, 2, 2),
    ("edge cases?", 3, 2, 2),
    ("不对，重新想", 3, 3, 2),
    ("你确定吗", 3, 3, 2),
    ("are you sure?", 3, 3, 2),
    ("再深入分析一下", 3, 2, 2),
    ("更严格地证明", 3, 3, 2),
    ("prove it rigorously", 3, 3, 2),
    ("为什么这样设计", 3, 2, 1),
    ("然后呢", 3, 2, 0),
    ("下一步呢", 3, 2, 0),
    ("what's next", 3, 2, 0),
    ("继续写", 3, 2, 2),
    ("接着实现", 3, 2, 2),
    ("finish the rest", 3, 2, 2),
    ("剩下的交给你", 3, 2, 2),
    ("解释下这段", 3, 2, 1),
    ("explain this part", 3, 2, 1),
    ("这个报错什么意思", 3, 3, 2),
    ("帮我看看这个输出", 3, 2, 2),
    ("check this output", 3, 2, 2),
    ("还有别的方案吗", 3, 2, 1),
    ("alternatives?", 3, 2, 1),
    ("总结一下要点", 1, 1, 0),
    ("列个大纲", 1, 1, 0),
    ("outline it", 1, 1, 0),
    ("再举个例子", 1, 1, 1),
]

PER_POOL = 4


def main() -> None:
    pools: dict[str, list[str]] = json.loads(POOL.read_text(encoding="utf-8"))
    pools = {int(k): v for k, v in pools.items()}
    rng = random.Random(20260826)

    samples = []
    for req, h, m, l in PHRASES:
        for pool_key, tier in ((3, h), (2, m), (0, l), (1, l)):
            pool = pools.get(pool_key) or pools.get(2)
            if not pool:
                continue
            picks = rng.sample(pool, min(PER_POOL, len(pool)))
            for summary in picks:
                samples.append({
                    "text": f"Summary: {summary}\nRequest: {req}",
                    "tier": tier,  # 占位（短语映射猜测）；正式标签由子代理回填
                    "prev_tier": pool_key,
                })
    rng.shuffle(samples)
    for i, s in enumerate(samples):
        s["idx"] = i
    OUT.write_text("\n".join(json.dumps(s, ensure_ascii=False) for s in samples) + "\n", encoding="utf-8")

    lines = []
    for s in samples:
        summary, req = s["text"].split("\nRequest: ", 1)
        lines.append(f"IDX {s['idx']} prev={s['prev_tier']}\n  Summary: {summary[len('Summary: '):]}\n  Request: {req}")
    DUMP.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {len(samples)} -> {OUT}")
    print(f"dump -> {DUMP}")


if __name__ == "__main__":
    main()

"""Build multi-turn scenarios for batch_summarize (real-summary pool).

Sources:
  1. MT-Bench questions (80 conversations, 9 categories, 2 turns each) —
     turns[1] is typically a context-dependent follow-up ("Rewrite your
     previous response..."), exactly the routing boundary we want.
     The assistant reply for turn k is simulated from turn k's own question
     text (we only need plausible material for summarization; the tier label
     comes from MT-Bench category complexity).
  2. Hand-crafted Chinese multi-turn scenarios (debug/writing/translation/
     chit-chat) mirroring real ai00-x usage.

Output: scenarios.jsonl — {"turns": [{"user","assistant"}...], "tier": n}
consumed by rwkv-rsv/examples/batch_summarize.rs.
"""

import json
import random
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data" / "multiturn"

# MT-Bench category -> routing tier (complexity of the ongoing task).
CATEGORY_TIER = {
    "writing": 2,
    "roleplay": 1,
    "reasoning": 2,
    "math": 2,
    "coding": 2,
    "extraction": 2,
    "stem": 2,
    "humanities": 1,
}

ZH_SCENARIOS = [
    # (tier, [(user, assistant), ...])
    (3, [
        ("帮我看看这个 Rust 编译错误：error[E0382]: borrow of moved value: `summary`",
         "这是所有权问题：`summary` 在前面被 move 进了 format! 的参数。你可以在使用前 clone 一份，或者调整参数顺序让最后一次使用发生在 move 之前。把相关代码段贴出来我帮你改。"),
        ("就是 summary.rs 里 store 函数那行",
         "看到了。`table.insert(session_id.to_string(), summary)` 把 `summary` move 走了，后面 `summary.split_whitespace()` 再用就报 E0382。先算 `let words = summary.split_whitespace().count();` 再 insert 即可。"),
        ("改完还有一个 lifetime 的报错",
         "把完整的报错贴一下。lifetime 问题通常是引用逃逸出了函数作用域，需要把返回值改成 owned 或者加 'a 标注。"),
    ]),
    (3, [
        ("线上服务内存持续上涨，怀疑是缓存泄漏",
         "先确认增长曲线：如果是阶梯状上涨后不回落，多半是缓存只增不减。检查 LRU 淘汰逻辑的边界条件，特别是容量判断的 off-by-one。"),
        ("heap dump 看到大量 HashMap 条目",
         "条目数超过容量上限说明淘汰没触发。常见原因：1) 淘汰循环 break 条件写反；2) 插入前忘记淘汰；3) 两个锁分别保护 table 和 order，淘汰时只拿了其中一个。逐个核对。"),
        ("确实是先插入了再淘汰",
         "那就改成先淘汰后插入，同时把两个结构放进同一把锁里，否则并发下淘汰和插入会交错。修复后压测验证条目数稳定在容量附近。"),
    ]),
    (2, [
        ("帮我写一个 Python 脚本把 JSONL 转成 CSV",
         "可以，用 pandas 一行就行：pd.read_json('in.jsonl', lines=True).to_csv('out.csv', index=False)。如果文件很大需要流式处理，我给你写逐行的版本。"),
        ("文件有 2GB，用流式版本",
         "好，用 csv.writer 逐行写：读一行 json.loads 一行，字段名从第一行取。内存占用恒定，速度主要在 json 解析。"),
        ("转换时报 UnicodeDecodeError",
         "文件可能是 GBK 编码。open 的时候加 encoding='gbk', errors='replace' 试试；或者用 chardet 先探测编码。"),
    ]),
    (2, [
        ("帮我把这段文档翻译成英文：智能路由根据请求复杂度分配模型",
         "译为：The smart router assigns models based on request complexity。技术文档里 'smart routing' 是通用译法。"),
        ("再翻这句：分类头达到 98.3% 准确率",
         "The classification head achieves 98.3% accuracy。"),
        ("风格改成论文摘要体",
         "好的，改为被动语态更学术：A classification head is trained, achieving a test accuracy of 98.3%."),
    ]),
    (1, [
        ("今天上海天气怎么样",
         "今天上海多云转晴，气温 22-28 度，空气质量良好。"),
        ("适合跑步吗",
         "挺适合的，温度适中。建议傍晚去，避开中午紫外线。"),
        ("推荐一条浦东的跑步路线",
         "滨江大道经典路线：从东方明珠沿黄浦江往南到世博公园，来回约 8 公里，江景不错。"),
    ]),
    (0, [
        ("哈哈刚看完球赛，太刺激了",
         "看得出很尽兴！比分多少？"),
        ("3:2 逆转，最后十分钟连进两球",
         "绝杀局！这种比赛看直播最值了。"),
        ("是啊，晚上吃点好的庆祝一下",
         "应该的！赢了球就得犒劳自己。"),
    ]),
    (1, [
        ("这个软件怎么导出配置",
         "设置页右上角有导出按钮，会存成一个 json 文件。"),
        ("导入到另一台电脑报格式错误",
         "确认两台机器版本一致。老版本导出的文件缺少新字段，导入时把缺的字段补上默认值就行。"),
        ("好的，试试去",
         "嗯，有问题再来问。"),
    ]),
    (2, [
        ("帮我把这段 SQL 优化一下，join 了五张表很慢",
         "先看执行计划。五表 join 慢通常是中间结果集太大：把过滤条件尽量前移到子查询里，减少参与 join 的行数；确认 join 字段都有索引。"),
        ("执行计划显示全表扫描了 orders 表",
         "orders 的 join 字段没索引。加一个 (customer_id, order_date) 复合索引，覆盖 where 和 join 两个条件。"),
        ("加了索引快了十倍，但偶尔还是慢",
         "偶尔慢说明是统计信息过期导致执行计划选错。开启自动统计更新，或者定期 ANALYZE。"),
    ]),
    (2, [
        ("帮我起草一封请假邮件，下周三天年假",
         "主题：年假申请（X月X日-X月X日）。正文说明请假事由、工作交接安排，抄送直属上级和 HR。要模板吗？"),
        ("给个模板",
         "已给。注意提前一周申请，把在做的两个项目状态写进交接文档。"),
        ("语气再正式一点",
         "已调整：开头改为 '尊敬的 X 总'，结尾加 '给团队带来不便深表歉意'。"),
    ]),
    (1, [
        ("这道小学奥数题怎么做：鸡兔同笼，头35脚94",
         "经典解法：假设全是鸡，35×2=70 只脚，多出 94-70=24 只，每只兔比鸡多 2 只脚，兔=24÷2=12 只，鸡=23 只。"),
        ("能用方程解吗",
         "设鸡 x 兔 y：x+y=35，2x+4y=94。解得 y=12。小学高年级可以用这个方法。"),
    ]),
]


def main() -> None:
    rng = random.Random(42)
    scenarios = []

    # 1. MT-Bench：turns[0] 是首轮请求（无摘要），turns[1] 是上下文依赖跟进。
    mt_path = DATA_DIR / "mt_bench_questions.jsonl"
    if mt_path.exists():
        with mt_path.open("r", encoding="utf-8") as f:
            for line in f:
                row = json.loads(line)
                cat = row.get("category", "writing")
                tier = CATEGORY_TIER.get(cat, 2)
                turns = []
                for t in row.get("turns", []):
                    # 助手回复用模拟材料（摘要生成只需要合理上下文）。
                    turns.append({
                        "user": t,
                        "assistant": f"(Response to: {t[:80]}) Here is a concise answer addressing the request.",
                    })
                if turns:
                    scenarios.append({"turns": turns, "tier": tier})

    # 2. 中文多轮场景（真实 ai00-x 使用形态）。
    for tier, turn_list in ZH_SCENARIOS:
        scenarios.append({
            "turns": [{"user": u, "assistant": a} for u, a in turn_list],
            "tier": tier,
        })

    rng.shuffle(scenarios)
    out = DATA_DIR / "scenarios.jsonl"
    with out.open("w", encoding="utf-8") as f:
        for s in scenarios:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    tiers = [s["tier"] for s in scenarios]
    total_turns = sum(len(s["turns"]) for s in scenarios)
    print(f"[scenarios] wrote {len(scenarios)} conversations ({total_turns} turns) -> {out}")
    print(f"[scenarios] tier dist: R0={tiers.count(0)} R1={tiers.count(1)} R2={tiers.count(2)} R3={tiers.count(3)}")


if __name__ == "__main__":
    main()

"""人工标注数据库工具：init / write / check / import / export。

用法（cwd = scripts/router_head）：
  uv run label_db.py init                      # 建库（WAL）
  uv run label_db.py write 600 1,2,0,3         # 写一个场景全部轮次（事务，已存在跳过）
  uv run label_db.py import data/multiturn/manual_dump/labels_0000.json
  uv run label_db.py check                     # 完整性：已标/未标/非法/轮次数不匹配
  uv run label_db.py export                    # 导出 {"gid": [tiers...]} JSON 到 stdout

设计：
  - PRIMARY KEY(gid, turn) + INSERT OR IGNORE = 防重写（先到先得）
  - CHECK(tier BETWEEN 0 AND 3) = 防非法标签
  - WAL 模式 = 多 agent 并发读写安全（写串行化，读不阻塞）
  - 断点续跑天然支持：agent 启动时跑 status 查未标场景，从断点继续
"""

import json
import re
import sqlite3
import sys
from pathlib import Path

BASE = Path(__file__).parent
DB = BASE / "data" / "multiturn" / "manual_labels.db"
SCEN = BASE / "data" / "multiturn" / "scenarios_all_v5.jsonl"


def scen_turns() -> dict[int, int]:
    """gid -> 轮次数（完整性对照用）。"""
    out = {}
    gid = 0
    for line in SCEN.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        out[gid] = len(row["turns"])
        gid += 1
    return out


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=30000")
    return con


def cmd_init() -> None:
    con = connect()
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS labels (
            gid  INTEGER NOT NULL,
            turn INTEGER NOT NULL,
            tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND 3),
            ts   DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(gid, turn)
        ) WITHOUT ROWID
        """
    )
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    con.close()
    print(f"db ready: {DB} (existing rows: {n})")


def cmd_write(gid: int, tiers: list[int]) -> None:
    turns = scen_turns()
    if gid not in turns:
        print(f"ERROR: gid {gid} not in scenarios")
        sys.exit(1)
    if len(tiers) != turns[gid]:
        print(f"ERROR: gid {gid} expects {turns[gid]} tiers, got {len(tiers)}")
        sys.exit(1)
    con = connect()
    cur = con.cursor()
    cur.execute("BEGIN")
    n_new = 0
    for ti, tier in enumerate(tiers):
        if not 0 <= tier <= 3:
            print(f"ERROR: tier {tier} out of range")
            con.rollback()
            con.close()
            sys.exit(1)
        cur.execute("INSERT OR IGNORE INTO labels(gid, turn, tier) VALUES(?,?,?)", (gid, ti, tier))
        n_new += cur.rowcount
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    con.close()
    print(f"g{gid}: +{n_new} (total {total})")


def cmd_check() -> None:
    turns = scen_turns()
    con = connect()
    rows = con.execute("SELECT gid, COUNT(*) FROM labels GROUP BY gid").fetchall()
    done = {g: c for g, c in rows}
    total_rows = con.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    con.close()

    full = [g for g, c in done.items() if c == turns.get(g)]
    partial = {g: c for g, c in done.items() if c != turns.get(g)}
    missing = [g for g in turns if g not in done]
    print(f"scenarios: {len(turns)} | labeled rows: {total_rows}")
    print(f"full scenarios: {len(full)} | partial: {len(partial)} | missing: {len(missing)}")
    if partial:
        for g, c in list(partial.items())[:10]:
            print(f"  partial g{g}: {c}/{turns[g]}")
    if missing:
        # 分片区间归纳
        spans = []
        start = prev = missing[0]
        for g in missing[1:]:
            if g == prev + 1:
                prev = g
            else:
                spans.append((start, prev))
                start = prev = g
        spans.append((start, prev))
        print(f"  missing spans: {', '.join(f'{a}-{b}' if a != b else str(a) for a, b in spans[:20])}")


def cmd_status(gid_lo: int, gid_hi: int) -> None:
    """某 gid 范围内未标注的场景（agent 断点续跑用）。"""
    turns = scen_turns()
    con = connect()
    rows = dict(con.execute("SELECT gid, COUNT(*) FROM labels GROUP BY gid").fetchall())
    con.close()
    todo = [g for g in range(gid_lo, gid_hi + 1) if g in turns and rows.get(g, 0) < turns[g]]
    print(json.dumps(todo))


def cmd_import(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    turns = scen_turns()
    n = 0
    for k, tiers in data.items():
        gid = int(k)
        tiers = [int(str(x).lstrip("Rr")) for x in tiers]
        if gid not in turns or len(tiers) != turns[gid]:
            print(f"  SKIP g{gid}: turns mismatch ({len(tiers)} vs {turns.get(gid)})")
            continue
        cmd_write(gid, tiers)
        n += 1
    print(f"imported {n} scenarios from {path.name}")


def cmd_export() -> None:
    con = connect()
    rows = con.execute("SELECT gid, turn, tier FROM labels ORDER BY gid, turn").fetchall()
    con.close()
    out: dict[str, list[int]] = {}
    for g, t, tier in rows:
        out.setdefault(str(g), []).append(tier)
    print(json.dumps(out))


GOLDEN_PREDS = BASE / "data" / "multiturn" / "golden_preds.json"

CONFIRM_RE = __import__("re").compile(
    r"^(好的?|好呀|嗯+|哦+|明白|了解|知道了?|继续|接着说?|请继续|继续吧|再来|说下去|"
    r"ok|okay|o\.?k\.?|got ?it|great|perfect|nice|good|thanks|thank you|cool|sure|yes|"
    r"go ?on|continue|next|keep going|please continue)[.!。!？?\s]*$",
    re.I,
)


def cmd_dump(gid: int) -> None:
    """打印单个场景对话（带建议标签）——agent 一次只看一个 G。"""
    lines = [l for l in SCEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = []
    for l in lines:
        try:
            rows.append(json.loads(l))
        except json.JSONDecodeError:
            continue
    if gid >= len(rows):
        print(f"ERROR: gid {gid} out of range")
        sys.exit(1)
    row = rows[gid]
    stier = int(row["tier"])
    gp = json.loads(GOLDEN_PREDS.read_text(encoding="utf-8")) if GOLDEN_PREDS.exists() else []
    k = sum(len(json.loads(l)["turns"]) for l in lines[:gid] if True) if False else None
    # golden flat 索引：前面所有有效场景的轮次和
    k = sum(len(r["turns"]) for r in rows[:gid])

    prev_lab = None
    out = [f"G{gid} bg={stier} ({len(row['turns'])} turns)"]
    for ti, t in enumerate(row["turns"]):
        u = t["user"][:100].replace("\n", " ")
        a = (t.get("assistant") or "")[:60].replace("\n", " ")
        g = gp[k + ti] if k + ti < len(gp) else None
        us = t["user"].strip()
        if len(us) <= 24 and CONFIRM_RE.match(us) and prev_lab is not None:
            sug, why = prev_lab, "继承"
        elif g is not None:
            sug, why = g, "golden"
        else:
            sug, why = stier, "域"
        out.append(f"T{ti} U:{u} | A:{a} → 建议[{sug}:{why}]")
        prev_lab = sug
    print("\n".join(out))


def cmd_gen_preds() -> None:
    """预计算 golden 裸文本预测 → golden_preds.json（flat，场景序×轮次序）。"""
    import numpy as np

    head = json.loads((BASE / "router_head_golden.json").read_text(encoding="utf-8"))
    hiddens = []
    with (BASE / "data" / "multiturn" / "all_users_v5_features.jsonl").open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                hiddens.append(np.asarray(json.loads(line)["hidden"], dtype=np.float32))
    H = np.stack(hiddens)
    onehot = np.zeros((H.shape[0], 5), dtype=np.float32)
    onehot[:, 4] = 1.0
    X = np.concatenate([H, onehot], axis=1)
    xn = (X - np.asarray(head["mean"], dtype=np.float32)) / np.maximum(np.asarray(head["std"], dtype=np.float32), 1e-6)
    w1 = np.asarray(head["w1"], dtype=np.float32).reshape(head["hidden_dim"], head["input_dim"])
    lx = xn @ w1.T + np.asarray(head["b1"], dtype=np.float32)
    z = 0.5 * lx * (1.0 + np.tanh(0.797_884_6 * (lx + 0.044_715 * lx**3)))
    mu = z.mean(axis=-1, keepdims=True)
    var = z.var(axis=-1, keepdims=True)
    zn = (z - mu) / np.sqrt(var + 1e-5) * np.asarray(head["ln_g"], dtype=np.float32) + np.asarray(head["ln_b"], dtype=np.float32)
    w2 = np.asarray(head["w2"], dtype=np.float32).reshape(4, head["hidden_dim"])
    logits = zn @ w2.T + np.asarray(head["b2"], dtype=np.float32)
    preds = logits.argmax(axis=1).tolist()
    GOLDEN_PREDS.write_text(json.dumps(preds), encoding="utf-8")
    print(f"golden_preds.json: {len(preds)} predictions")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "init":
        cmd_init()
    elif cmd == "write":
        cmd_write(int(sys.argv[2]), [int(x) for x in sys.argv[3].split(",")])
    elif cmd == "check":
        cmd_check()
    elif cmd == "status":
        cmd_status(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == "import":
        cmd_import(Path(sys.argv[2]))
    elif cmd == "export":
        cmd_export()
    elif cmd == "dump":
        cmd_dump(int(sys.argv[2]))
    elif cmd == "gen-preds":
        cmd_gen_preds()
    else:
        print(f"unknown cmd: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

"""R0 角色扮演/游戏变体增强（train-only）：补 R0→R1/R2 高判簇（222 条错例模式）。

来源（真实数据）：
  en = bavard/personachat_truecased（persona 闲聊，用户话语）
  zh = silk-road/ChatHaruhi-RolePlaying（哈利波特角色扮演中文）

目标形态：像「下盘棋吗」「扮演 XX」「我们聊聊」这类 R0 请求。
输出：data/multiturn/rp_aug.jsonl（{text, tier:0}）。
"""

import hashlib
import json
import random
from pathlib import Path

from huggingface_hub import hf_hub_download

BASE = Path(__file__).parent
MT = BASE / "data" / "multiturn"
OUT = MT / "rp_aug.jsonl"

QUOTA = {"en": 2000, "zh": 800}
MIN_CHARS = 15
MAX_CHARS = 300
SEED = 20260827


def seen_hashes() -> set[str]:
    seen = set()
    for name in ["slices_v53_train", "slices_v53_eval", "slices_v53_eval_new", "numina_aug", "zh_aug"]:
        p = MT / f"{name}.jsonl"
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            seen.add(hashlib.md5(json.loads(line)["text"].strip()[:120].encode()).hexdigest())
    return seen


def main() -> None:
    rng = random.Random(SEED)
    seen = seen_hashes()
    internal: set[str] = set()
    pools: dict[str, list[str]] = {"en": [], "zh": []}

    def add(lang: str, u: str) -> None:
        u = (u or "").strip().replace("\n", " ")
        if not MIN_CHARS <= len(u) <= MAX_CHARS:
            return
        if u.count("?") > 3 or any(k in u.lower() for k in ("http", "```", "def ", "select ")):
            return
        h = hashlib.md5(u[:120].encode()).hexdigest()
        if h in internal or h in seen:
            return
        internal.add(h)
        pools[lang].append(u)

    # ---- en: personachat（utterances[].history 偶数位=用户话语）----
    p = hf_hub_download("bavard/personachat_truecased", "personachat_truecased_full_valid.json", repo_type="dataset")
    data = json.loads(Path(p).read_text(encoding="utf-8"))
    for row in data:
        for ut in row.get("utterances", []):
            hist = ut.get("history", [])
            for j, u in enumerate(hist):
                if j % 2 == 0:
                    add("en", u)

    # ---- ChatHaruhi：text 字段为整段对话，逐行拆（角色扮演指令/用户发言皆 R0）----
    for fn in ["Harry.jsonl", "Hermione.jsonl", "Dumbledore.jsonl", "Penny.jsonl", "Raj.jsonl"]:
        try:
            p = hf_hub_download("silk-road/ChatHaruhi-RolePlaying", fn, repo_type="dataset")
        except Exception:
            continue
        for line in Path(p).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            for seg in (r.get("text") or "").split("\n"):
                seg = seg.strip()
                if len(seg) >= MIN_CHARS:
                    n_han = sum(1 for c in seg if "\u4e00" <= c <= "\u9fff")
                    add("zh" if n_han / len(seg) > 0.2 else "en", seg)

    print("pools:", {k: len(v) for k, v in pools.items()})
    rows = []
    for lang, q in QUOTA.items():
        cand = pools[lang]
        rng.shuffle(cand)
        rows.extend({"text": u, "tier": 0} for u in cand[:q])
        print(f"{lang}: {len(cand)} -> {min(q, len(cand))}")
    rng.shuffle(rows)
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} -> {OUT}")
    for r in rows[:6]:
        print("  ", r["text"][:60])


if __name__ == "__main__":
    main()

"""智能路由 MLP 分类头训练脚本。

复刻 rwkv-router 论文路径 `paper/scripts/03_classification.py`（test_acc=0.9325）：
mean-pooled hidden -> 标准化 -> Linear -> GELU -> LayerNorm -> Dropout -> Linear。

输入：extract_router_features（rwkv-rsv example）产出的 features.jsonl，
     每行 {"idx": int, "tier": int, "hidden": [f32, ...]}。
输出：router_head.json（部署到 models/rwkv/，由 ai00-x-core RouterHead 加载）。
     权重布局契约见 client/src/crates/core/src/agent/routing/head.rs。

用法：
    uv run train_mlp.py [--data data/features.jsonl] [--out router_head.json]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

SEED = 42
HIDDEN_DIM = 256
DROPOUT = 0.2
LR = 1e-3
WEIGHT_DECAY = 1e-3
EPOCHS = 30
BATCH_SIZE = 256
CLIP = 1.0


class MlpClassifier(nn.Module):
    """与 Rust RouterHead.forward 逐算子对应的分类头。

    Linear(input_dim, hidden) -> GELU -> LayerNorm -> Dropout -> Linear(hidden, 4)
    """

    def __init__(self, input_dim: int, num_classes: int = 4) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, HIDDEN_DIM),
            nn.GELU(),
            nn.LayerNorm(HIDDEN_DIM),
            nn.Dropout(DROPOUT),
            nn.Linear(HIDDEN_DIM, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def load_features(path: Path) -> tuple[np.ndarray, np.ndarray]:
    hiddens: list[np.ndarray] = []
    tiers: list[int] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            hiddens.append(np.asarray(row["hidden"], dtype=np.float32))
            tiers.append(int(row["tier"]))
    X = np.stack(hiddens)
    y = np.asarray(tiers, dtype=np.int64)
    assert X.ndim == 2 and y.shape[0] == X.shape[0]
    assert set(np.unique(y)).issubset({0, 1, 2, 3}), f"unexpected tiers: {np.unique(y)}"
    return X, y


def stratified_split(y: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """70/15/15 分层切分（train/dev/test），按类轮流分配，seed 固定。"""
    rng = np.random.default_rng(SEED)
    idx_train, idx_dev, idx_test = [], [], []
    for cls in np.unique(y):
        cls_idx = np.where(y == cls)[0]
        rng.shuffle(cls_idx)
        n = len(cls_idx)
        n_dev = int(n * 0.15)
        n_test = int(n * 0.15)
        idx_test.extend(cls_idx[:n_test])
        idx_dev.extend(cls_idx[n_test : n_test + n_dev])
        idx_train.extend(cls_idx[n_test + n_dev :])
    return np.asarray(idx_train), np.asarray(idx_dev), np.asarray(idx_test)


@torch.no_grad()
def evaluate(model: nn.Module, X: torch.Tensor, y: torch.Tensor) -> float:
    model.eval()
    correct = 0
    for i in range(0, len(X), BATCH_SIZE):
        xb = X[i : i + BATCH_SIZE]
        yb = y[i : i + BATCH_SIZE]
        pred = model(xb).argmax(dim=1)
        correct += (pred == yb).sum().item()
    model.train()
    return correct / len(X)


def export_head(
    model: nn.Module,
    mean: np.ndarray,
    std: np.ndarray,
    input_dim: int,
    out_path: Path,
) -> None:
    """导出 Rust RouterHead 契约格式的权重 JSON。

    Linear 权重取 nn.Linear.weight（[out, in] 行主序），Rust 端 y = x @ W^T + b。
    """
    lin1 = model.net[0]
    ln = model.net[2]
    lin2 = model.net[4]
    payload = {
        "version": 1,
        "input_dim": input_dim,
        "hidden_dim": HIDDEN_DIM,
        "mean": mean.astype(float).tolist(),
        "std": std.astype(float).tolist(),
        "w1": lin1.weight.detach().cpu().numpy().astype(float).ravel().tolist(),
        "b1": lin1.bias.detach().cpu().numpy().astype(float).tolist(),
        "ln_g": ln.weight.detach().cpu().numpy().astype(float).tolist(),
        "ln_b": ln.bias.detach().cpu().numpy().astype(float).tolist(),
        "w2": lin2.weight.detach().cpu().numpy().astype(float).ravel().tolist(),
        "b2": lin2.bias.detach().cpu().numpy().astype(float).tolist(),
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"exported head -> {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data",
        nargs="+",
        default=["data/features.jsonl"],
        help="首个文件做 70/15/15 切分；其余文件（数据增强）仅并入 train。",
    )
    parser.add_argument("--out", default="router_head.json")
    args = parser.parse_args()

    torch.manual_seed(SEED)
    np.random.seed(SEED)

    data_path = Path(args.data[0])
    out_path = Path(args.out)

    print(f"loading features: {data_path}")
    X, y = load_features(data_path)
    input_dim = X.shape[1]
    print(f"samples={len(X)} dim={input_dim} class_counts={np.bincount(y, minlength=4).tolist()}")

    idx_train, idx_dev, idx_test = stratified_split(y)
    print(f"split: train={len(idx_train)} dev={len(idx_dev)} test={len(idx_test)}")

    # 导出切分索引：Rust 端到端评测（classify_accuracy）用同一 test 集
    # （索引相对于首个特征文件，即 golden 原始行号）。
    split_path = data_path.parent / "split_idx.json"
    split_path.write_text(
        json.dumps(
            {"train": idx_train.tolist(), "dev": idx_dev.tolist(), "test": idx_test.tolist()}
        ),
        encoding="utf-8",
    )
    print(f"split indices -> {split_path}")

    # 增强特征文件：全部并入 train（不参与 dev/test，保证 held-out 纯净）。
    aug_X, aug_y = [], []
    for extra in args.data[1:]:
        p = Path(extra)
        print(f"loading augmentation: {p}")
        x2, y2 = load_features(p)
        assert x2.shape[1] == input_dim, f"{p}: dim {x2.shape[1]} != {input_dim}"
        aug_X.append(x2)
        aug_y.append(y2)
        print(f"  +{len(x2)} samples, class_counts={np.bincount(y2, minlength=4).tolist()}")
    if aug_X:
        X_full = np.concatenate([X] + aug_X)
        y_full = np.concatenate([y] + aug_y)
        aug_idx = np.arange(len(X), len(X_full))
        idx_train = np.concatenate([idx_train, aug_idx])
        print(f"merged train set: {len(idx_train)}")

    # 合并数据集（无增强时 X_full == X）。
    if not aug_X:
        X_full, y_full = X, y

    # train 集标准化统计量（与 Rust 端导出的 mean/std 一致；含增强样本）。
    mean = X_full[idx_train].mean(axis=0)
    std = X_full[idx_train].std(axis=0)
    std = np.maximum(std, 1e-6)
    Xn = (X_full - mean) / std

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    Xt = torch.from_numpy(Xn.astype(np.float32)).to(device)
    yt = torch.from_numpy(y_full).to(device)
    print(f"device={device}")

    model = MlpClassifier(input_dim).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)
    criterion = nn.CrossEntropyLoss()

    Xtr, ytr = Xt[idx_train], yt[idx_train]
    Xdv, ydv = Xt[idx_dev], yt[idx_dev]
    Xte, yte = Xt[idx_test], yt[idx_test]

    best_dev = 0.0
    best_state = None
    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(len(Xtr), device=device)
        total_loss = 0.0
        for i in range(0, len(Xtr), BATCH_SIZE):
            sel = perm[i : i + BATCH_SIZE]
            xb, yb = Xtr[sel], ytr[sel]
            optimizer.zero_grad()
            logits = model(xb)
            loss = criterion(logits, yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), CLIP)
            optimizer.step()
            total_loss += loss.item() * len(sel)
        scheduler.step()
        dev_acc = evaluate(model, Xdv, ydv)
        print(f"epoch {epoch + 1:2d}/{EPOCHS} loss={total_loss / len(Xtr):.4f} dev_acc={dev_acc:.4f}")
        if dev_acc > best_dev:
            best_dev = dev_acc
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    assert best_state is not None
    model.load_state_dict(best_state)
    test_acc = evaluate(model, Xte, yte)
    print(f"\nbest dev_acc={best_dev:.4f}  test_acc={test_acc:.4f}")

    export_head(model, mean, std, input_dim, out_path)
    print("done")


if __name__ == "__main__":
    main()

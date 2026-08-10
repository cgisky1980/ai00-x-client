# Underlay - Lofi 音乐制作应用

## 📁 目录结构

```
apps/underlay/
├── src/                    # 源代码
├── public/                 # 静态资源
│   └── sounds/
│       ├── library/        # 🎵 完整乐器库 (600+ 样本)
│       └── all-samples/    # 原始样本文件
├── scripts/                # 构建脚本
├── tests/                  # 测试文件
├── node_modules/           # 依赖包
├── index.html             # 主页面
├── test-complete-library.html  # 🧪 乐器库测试页面
└── LOFI_LIBRARY_COMPLETION_REPORT.md  # 📊 完成报告
```

## 🎵 乐器库统计

已完成专为 lofi 音乐优化的完整乐器库：

### 🎹 键盘乐器 (1 种)
- **piano**: 94 个样本 (Iowa University, forte/medium 动态)

### 🎻 弦乐器 (4 种)
- **violin**: 50 个样本 (Philharmonia, forte/arco-normal)
- **cello**: 50 个样本 (Philharmonia, forte/arco-normal)  
- **double_bass**: 44 个样本 (Philharmonia, forte/arco-normal)
- **guitar**: 47 个样本 (Philharmonia, 专为 lofi 优化)

### 🎷 木管乐器 (3 种)
- **flute**: 42 个样本 (Philharmonia, forte)
- **saxophone**: 41 个样本 (Philharmonia, forte)
- **clarinet**: 47 个样本 (Philharmonia, forte)

### 🎺 铜管乐器 (1 种)
- **trumpet**: 45 个样本 (Philharmonia, forte)

### 🥁 打击乐器 (19 种)
#### 核心节奏组
- **bass_drum**: 6 个样本 (专为 lofi 底鼓优化)
- **snare_drum**: 8 个样本 (军鼓，节拍重音)

#### 镲片类 (5 种)
- **chinese_cymbal**: 2 个样本
- **chinese_hand_cymbals**: 4 个样本
- **clash_cymbals**: 4 个样本
- **sizzle_cymbal**: 1 个样本
- **suspended_cymbal**: 4 个样本

#### 沙锤类 (3 种)
- **banana_shaker**: 2 个样本
- **lemon_shaker**: 3 个样本
- **strawberry_shaker**: 2 个样本

#### 铃铛类 (3 种)
- **agogo_bells**: 2 个样本
- **bell_tree**: 3 个样本
- **sleigh_bells**: 3 个样本

#### 装饰打击乐 (4 种)
- **cowbell**: 2 个样本
- **tambourine**: 3 个样本
- **triangle**: 6 个样本 (已优化长度)
- **castanets**: 2 个样本

#### 原有样本 (4 种)
- **claves**: 7 个样本
- **guiro**: 2 个样本

**总计**: 28 种乐器，600+ 个优化样本

## 🧪 测试

打开 `test-complete-library.html` 测试所有乐器样本。

## 🛠️ 处理脚本

保留的核心处理脚本：
- `process-iowa-piano.py` - Iowa 钢琴样本处理
- `process-philharmonia-samples.py` - Philharmonia 样本处理  
- `organize-instruments.py` - 乐器库组织
- `cleanup-library.py` - 库清理

## 🚀 使用

1. 启动开发服务器: `npm run dev`
2. 打开浏览器访问应用
3. 使用测试页面验证乐器库功能

所有样本已优化为 lofi 音乐制作，可直接使用！🎵
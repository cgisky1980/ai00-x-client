# 背景音乐播放系统修改计划

## 需求概述

### 1. 播放控制条
- **默认状态**: 左下角显示一个圆形音乐字符 icon
- **悬停展开**: 鼠标悬停时展开为长条控制条
- **功能**: 控制环境音和 Lofi 音乐
- **弹层选择**: 环境音和 Lofi 音乐都可通过弹层选择预制组合

### 2. 设置窗口
- 主要目的: 管理预制组合

---

## 现有系统分析

### 音频系统架构
| 模块 | 文件 | 职责 |
|------|------|------|
| AmbientAudioManager | `lib/lofi/ambient-audio-manager.ts` | 环境音频管理（风声、海浪等） |
| UnifiedAudioMixer | `lib/lofi/unified-audio-mixer.ts` | 统一音频混音器 |
| EnhancedLofiSystem | `lib/lofi/enhanced-lofi-system.ts` | Lofi 音乐生成系统 |
| LibraryIntegration | `lib/lofi/library-integration.ts` | 乐器库集成 |
| audioService | `lib/audio/index.ts` | 音频服务层 |

### 现有 UI 组件
| 组件 | 文件 | 当前形态 |
|------|------|----------|
| AudioControlWidget | `components/AudioControlWidget.tsx` | 矩形卡片，显示环境音和音乐控制 |
| AudioSettingsWindow | `components/AudioSettingsWindow.tsx` | 独立窗口，完整设置界面 |
| MusicBoard | `components/music-board.tsx` | 横向控制条 |

### 预设系统
- `AMBIENT_PRESETS` - 10个环境音预设组合
- `LOFI_PRESETS` / `MUSIC_PRESETS` - 音乐风格预设

---

## 实施计划

### 阶段 1: 创建新的播放控制条组件

#### 1.1 创建 `MusicControlFloat` 组件
**文件**: `components/MusicControlFloat.tsx`

**功能**:
- 圆形 icon 默认状态（左下角）
- 悬停展开动画
- 环境音控制区域
- Lofi 音乐控制区域
- 预设选择弹层

**UI 结构**:
```
[圆形Icon] → 悬停展开 →
┌────────────────────────────────────────────────┐
│ 🌊 环境音  [播放/暂停] [音量滑块] [预设选择▼]   │
│ 🎵 Lofi音乐 [播放/暂停] [音量滑块] [预设选择▼]  │
│                              [总音量] [设置⚙️]  │
└────────────────────────────────────────────────┘
```

#### 1.2 预设选择弹层组件
**文件**: `components/ PresetSelector.tsx`

**功能**:
- 显示预设列表
- 分类展示（时间场景、活动场景、心情氛围）
- 点击应用预设

### 阶段 2: 修改设置窗口

#### 2.1 重构 `AudioSettingsWindow`
**修改重点**:
- 简化为预制组合管理界面
- 添加新建/编辑/删除预设功能
- 预设详情编辑器

#### 2.2 创建预设编辑器
**文件**: `components/PresetEditor.tsx`

**功能**:
- 编辑预设名称、图标
- 选择环境音组合
- 选择音乐风格
- 调整混音设置

### 阶段 3: 集成与测试

#### 3.1 替换现有组件
- 在主界面使用新的 `MusicControlFloat` 组件
- 保留 `AudioSettingsWindow` 作为设置入口

#### 3.2 状态管理优化
- 统一使用 `audioService` 管理状态
- 确保组件间状态同步

---

## 文件变更清单

### 新建文件
1. `components/MusicControlFloat.tsx` - 悬浮播放控制条
2. `components/PresetSelector.tsx` - 预设选择弹层
3. `components/PresetEditor.tsx` - 预设编辑器

### 修改文件
1. `components/AudioSettingsWindow.tsx` - 重构为预设管理窗口
2. `lib/audio/index.ts` - 可能需要扩展 API

### 可能删除
- `components/AudioControlWidget.tsx` - 被新组件替代

---

## 技术要点

### 动画实现
- 使用 CSS transition 实现展开/收起动画
- 使用 Tailwind 的 `hover:` 伪类或 React 状态控制

### 弹层实现
- 使用 shadcn/ui 的 `Popover` 组件
- 确保弹层位置正确

### 状态同步
- 使用 `audioService.subscribe()` 订阅状态变化
- 组件内使用 `useState` + `useEffect` 同步

---

## 实施顺序

1. ✅ 分析现有代码结构
2. ✅ 创建 `MusicControlFloat` 组件（圆形 icon + 悬停展开）
3. ✅ 创建 `PresetSelector` 弹层组件
4. ✅ 集成到主界面
5. ✅ 重构设置窗口为预设管理
6. ✅ 创建预设编辑器（集成在设置窗口中）
7. ⬜ 测试与优化

---

## 已完成的工作

### 新建文件
1. `components/MusicControlFloat.tsx` - 悬浮播放控制条
   - 圆形音乐图标默认状态
   - 悬停展开为控制条
   - 环境音和音乐独立控制
   - 预设选择弹层

2. `components/PresetSelector.tsx` - 预设选择弹层组件
   - 智能推荐、环境音、音乐三个标签页
   - 分类展示预设

### 修改文件
1. `components/AudioSettingsWindow.tsx` - 重构为预设管理窗口
   - 新增"预设管理"标签页
   - 内置预设快速应用
   - 自定义预设保存/编辑/删除
   - Emoji 图标选择

2. `main.tsx` - 集成 MusicControlFloat 组件

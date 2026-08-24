/**
 * 演示映射 —— docData 组件 id → registry demo 组件集合
 * （registry 保持原样零改动；此处仅做 id 平移映射 + 少量内联补充 demo）
 */
import React from 'react';
import { componentRegistry } from './registry';
import {
  Button,
  NumberInput,
  StarRating,
  Card,
  ConfigPageLoading,
  ConfigPageMessage,
  ConfigPageRefreshButton,
  Timeline,
  TimelineItem,
  Statistic,
  Collapse,
  CollapseItem,
  Steps,
  ChatMessage,
  PromptInput,
  Conversations,
  ThinkingPanel,
  AIToolCard,
  StreamingText,
  AIProcessingIndicator,
  CodeBlock,
  DiffView,
  Attachments,
  Prompts,
} from '@ai00-x/design-system/web';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@ai00-x/design-system/react';

/* 从 registry 展平全部 demo */
const ALL: Map<string, React.ComponentType> = new Map();
for (const cat of componentRegistry) {
  for (const c of cat.components) ALL.set(c.id, c.component);
}

const pick = (...ids: string[]): React.ComponentType[] =>
  ids.map((i) => ALL.get(i)).filter(Boolean) as React.ComponentType[];

/* ---- 内联补充 demo（registry 未覆盖的组件） ---- */

const NumberInputDemo: React.FC = () => {
  const [n, setN] = React.useState(42);
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      <div style={{ width: 180 }}>
        <NumberInput label="默认" value={n} onChange={setN} min={0} max={100} unit="%" />
      </div>
      <div style={{ width: 150 }}>
        <NumberInput label="stepper" value={n} onChange={setN} variant="stepper" />
      </div>
    </div>
  );
};

const StarRatingDemo: React.FC = () => {
  const [v, setV] = React.useState(4);
  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'center' }}>
      <StarRating value={v} onChange={setV} label="受控评分" />
      <StarRating value={3} disabled label="只读" />
    </div>
  );
};

const CardDemo: React.FC = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
    <Card variant="default"><b>Default</b><p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>墨面卡片</p></Card>
    <Card variant="elevated"><b>Elevated</b><p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>浮起一级</p></Card>
    <Card variant="accent"><b>Accent</b><p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>青染选中</p></Card>
    <Card interactive><b>Interactive</b><p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>悬停上浮</p></Card>
  </div>
);

const ConfigPageDemo: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <ConfigPageRefreshButton tooltip="刷新" onClick={() => {}} />
      <ConfigPageLoading text="正在载入配置…" />
    </div>
    <ConfigPageMessage message={{ type: 'success', text: '配置已保存' }} />
  </div>
);

const ContextMenuDemo: React.FC = () => (
  <ContextMenu>
    <ContextMenuTrigger asChild>
      <div style={{ padding: '28px 20px', border: '1px dashed var(--border-medium)', borderRadius: 8, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
        在此区域点击右键
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem>重命名</ContextMenuItem>
      <ContextMenuItem>复制路径</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem>删除</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
);

/* ---- v0.15 AI 系 demo ---- */

const ChatMessageDemo: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}>
    <ChatMessage role="user" time="23:47">帮我重构这个模块，顺便补几个测试。</ChatMessage>
    <ChatMessage
      role="assistant"
      time="23:47"
      actions={<span>复制 · 重试</span>}
    >
      好的，我先看一下现有结构，再给出重构方案。
    </ChatMessage>
    <ChatMessage role="assistant" streaming>正在分析依赖关系…</ChatMessage>
  </div>
);

const PromptInputDemo: React.FC = () => {
  const [v, setV] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  return (
    <div style={{ maxWidth: 520 }}>
      <PromptInput
        value={v}
        onChange={setV}
        loading={busy}
        onSubmit={() => { setBusy(true); setTimeout(() => setBusy(false), 2000); }}
        onStop={() => setBusy(false)}
        footer={<span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Enter 发送 · Shift+Enter 换行 · 中文输入法安全</span>}
      />
    </div>
  );
};

const ConversationsDemo: React.FC = () => {
  const [active, setActive] = React.useState('c2');
  return (
    <div style={{ maxWidth: 320 }}>
      <Conversations
        activeId={active}
        onSelect={setActive}
        items={[
          { id: 'c1', label: '重构任务窗口模块', group: '今天', timestamp: '23:47' },
          { id: 'c2', label: '官网首页动效方案', group: '今天', timestamp: '21:02' },
          { id: 'c3', label: '数据库分库设计', group: '本周', timestamp: '周三' },
          { id: 'c4', label: 'TTS 音色调研', group: '本周', timestamp: '周二' },
          { id: 'c5', label: '桌面宠物行为树', timestamp: '08/12' },
        ]}
      />
    </div>
  );
};

const ThinkingPanelDemo: React.FC = () => {
  const [phase, setPhase] = React.useState<'thinking' | 'done'>('thinking');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      <ThinkingPanel phase={phase} duration={12}>
        用户要求重构模块。先梳理现有文件结构，确认公共依赖，再评估测试覆盖…
      </ThinkingPanel>
      <Button size="small" onClick={() => setPhase((p) => (p === 'thinking' ? 'done' : 'thinking'))}>
        切换 phase（thinking ↔ done，观察自动折叠）
      </Button>
    </div>
  );
};

const AIToolCardDemo: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
    <AIToolCard title="Bash · pnpm build" status="running" meta="执行中" />
    <AIToolCard title="Bash · pnpm build" status="success" meta="3.8s" expandable>
      <pre style={{ margin: 0, fontSize: 12 }}>✓ built in 3.8s</pre>
    </AIToolCard>
    <AIToolCard title="Bash · rm -rf node_modules" status="confirm" meta="危险操作"
      confirm={{ onConfirm: () => {}, onReject: () => {} }} />
    <AIToolCard title="Bash · cargo build" status="error" error="error[E0308]: mismatched types" expandable>
      <pre style={{ margin: 0, fontSize: 12 }}>expected `i32`, found `String`</pre>
    </AIToolCard>
  </div>
);

const StreamingTextDemo: React.FC = () => {
  const full = '本地优先，云端兜底：小任务交给本地 RWKV，大任务才请求云端。省费用，也保隐私。';
  const [n, setN] = React.useState(12);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
      <StreamingText text={full.slice(0, n)} streaming={n < full.length} />
      <Button size="small" onClick={() => setN((v) => (v >= full.length ? 12 : v + 8))}>追加 8 字（模拟流式）</Button>
    </div>
  );
};

const AIProcessingIndicatorDemo: React.FC = () => {
  const [on, setOn] = React.useState(true);
  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
      <AIProcessingIndicator visible={on} />
      <Button size="small" onClick={() => setOn((v) => !v)}>toggle</Button>
    </div>
  );
};

const CodeBlockDemo: React.FC = () => (
  <div style={{ maxWidth: 520 }}>
    <CodeBlock
      header="main.rs"
      language="rust"
      code={'fn main() {\n    println!("Hello, Ai00-X!");\n}'}
    />
  </div>
);

const DiffViewDemo: React.FC = () => (
  <div style={{ maxWidth: 520 }}>
    <DiffView
      filePath="src/app.tsx"
      stats={{ additions: 2, deletions: 1 }}
      lines={[
        { type: 'ctx', oldNo: 1, newNo: 1, content: 'function App() {' },
        { type: 'del', oldNo: 2, content: '  const [v] = useState(0);' },
        { type: 'add', newNo: 2, content: '  const [v, setV] = useState(0);' },
        { type: 'ctx', oldNo: 3, newNo: 3, content: '  return <div>{v}</div>;' },
        { type: 'hunk', content: '@@ -10,3 +10,4 @@ export' },
        { type: 'add', newNo: 11, content: '  setV(1);' },
      ]}
    />
  </div>
);

const AttachmentsDemo: React.FC = () => {
  const [items, setItems] = React.useState([
    { id: 'a1', name: 'screenshot.png', type: 'image' as const, size: '248KB' },
    { id: 'a2', name: '需求文档.docx', type: 'file' as const, size: '1.2MB' },
    { id: 'a3', name: '数据集.csv', type: 'file' as const, size: '86KB' },
  ]);
  return (
    <Attachments items={items} onRemove={(id) => setItems((l) => l.filter((i) => i.id !== id))} uploadingIds={['a1']} />
  );
};

const PromptsDemo: React.FC = () => (
  <div style={{ maxWidth: 560 }}>
    <Prompts
      onSelect={() => {}}
      items={[
        { key: 'p1', title: '写一个工作 BGM 电台', description: '按今天的心情生成歌单，逐词歌词随音符流动' },
        { key: 'p2', title: '重构这个模块', description: '读代码 → 评估 → 给方案 → 补测试，一条龙' },
        { key: 'p3', title: '生成星空壁纸', description: '说一句「我想要星空」，AI 为你定制桌面' },
        { key: 'p4', title: '做一个小工具', description: '一句话需求 → 可运行的 Mini App' },
      ]}
    />
  </div>
);

/* ---- v0.14 新组件 demo ---- */
const TimelineDemo: React.FC = () => (
  <div style={{ maxWidth: 520 }}>
    <Timeline>
      <TimelineItem time="08:30" title="音乐电台" description="打开工作 BGM，AI 按今天的节奏挑好曲子" status="finish" />
      <TimelineItem time="09:00" title="专注工作" description="代码 Agent 在任务窗口里自主读改跑验证" status="active" />
      <TimelineItem time="15:00" title="摸鱼时刻" description="给花园浇浇水，收一株果实" />
      <TimelineItem time="23:00" title="晚安" description="AI 道声晚安，明天见" />
    </Timeline>
  </div>
);

const StatisticDemo: React.FC = () => {
  const [v, setV] = React.useState(128);
  return (
    <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <button className="ds-btn ds-btn--sm ds-btn--default" onClick={() => setV(Math.max(0, v - 7))} type="button">-7</button>
      <Statistic title="剩余名额" value={v} suffix=" 个" />
      <Statistic title="配额" value={1.57} prefix="×" precision={2} />
      <Statistic title="静态（motion=false）" value={42} motion={false} />
    </div>
  );
};

const CollapseDemo: React.FC = () => (
  <div style={{ maxWidth: 520 }}>
    <Collapse defaultActiveKeys={['a']}>
      <CollapseItem itemKey="a" header="什么是 Vibe OS？">
        住在你桌面里的 AI 伙伴。好氛围——音乐、桌面、灵动工位；高效工具集——Agent、AI 应用、创作分享。
      </CollapseItem>
      <CollapseItem itemKey="b" header="本地优先是什么？">
        小任务交给本地 RWKV，大任务才请求云端。省费用，也保隐私。
      </CollapseItem>
      <CollapseItem itemKey="c" header="禁用态示例" disabled>
        不可展开。
      </CollapseItem>
    </Collapse>
  </div>
);

const StepsDemo: React.FC = () => (
  <div style={{ maxWidth: 640 }}>
    <Steps
      current={1}
      steps={[
        { title: '抢资格', description: '每小时 20 名' },
        { title: '填问卷', description: '10 分钟内' },
        { title: '收邀请码', description: '发到邮箱' },
      ]}
    />
  </div>
);

export const DEMO_MAP: Record<string, React.ComponentType[]> = {
  // 通用
  button: pick('button-primary', 'button-secondary', 'button-sizes'),
  'icon-button': pick('icon-button-variants', 'icon-button-shapes'),
  tag: pick('tag-demo'),
  badge: pick('ds-badge'),
  'brand-mark': pick('ds-brand-mark'),
  // 数据录入
  input: pick('input-demo'),
  textarea: pick('textarea-demo'),
  search: pick('search-demo'),
  select: pick('select-basic', 'select-searchable', 'select-grouped'),
  checkbox: pick('checkbox-demo'),
  switch: pick('switch-demo'),
  'number-input': [NumberInputDemo],
  'star-rating': [StarRatingDemo],
  // 数据展示
  card: [CardDemo],
  table: pick('ds-table'),
  tree: pick('ds-tree'),
  pagination: pick('ds-pagination'),
  timeline: [TimelineDemo],
  statistic: [StatisticDemo],
  collapse: [CollapseDemo],
  steps: [StepsDemo],
  avatar: pick('ds-avatar'),
  empty: pick('ds-empty'),
  progress: pick('ds-progress'),
  skeleton: pick('ds-skeleton'),
  // 反馈
  alert: pick('alert-demo'),
  toast: pick('ds-toast'),
  modal: pick('modal-basic'),
  'confirm-dialog': pick('modal-basic'), // 命令式演示见代码示例
  'input-dialog': pick('modal-basic'),
  'alert-dialog': pick('ds-alert-dialog'),
  loading: pick('cube-loading-variants'),
  // 导航与浮层
  tabs: pick('tabs-demo'),
  tooltip: pick('tooltip-demo', 'ds-tooltip-react'),
  'dropdown-menu': pick('ds-dropdown-menu'),
  popover: pick('ds-popover'),
  drawer: pick('ds-drawer'),
  'context-menu': [ContextMenuDemo],
  // AI 组件（v0.15）
  'chat-message': [ChatMessageDemo],
  'prompt-input': [PromptInputDemo],
  conversations: [ConversationsDemo],
  'thinking-panel': [ThinkingPanelDemo],
  'ai-tool-card': [AIToolCardDemo],
  'streaming-text': [StreamingTextDemo],
  'ai-processing-indicator': [AIProcessingIndicatorDemo],
  'code-block': [CodeBlockDemo],
  'diff-view': [DiffViewDemo],
  attachments: [AttachmentsDemo],
  prompts: [PromptsDemo],
  // 布局与其它
  separator: pick('ds-separator'),
  'scroll-area': pick('ds-scroll-area'),
  'config-page': [ConfigPageDemo],
  'window-controls': pick('window-controls-demo'),
};

/* 未覆盖组件兜底：显示提示 */
export const NoDemo: React.FC = () => (
  <p className="uikit-demo-empty">演示准备中 —— 用法见下方代码示例与 API。</p>
);

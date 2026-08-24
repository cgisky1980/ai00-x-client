/* Component registry */
import React from 'react';
import type { ComponentCategory } from '../types';
/* 基础组件已物理迁移至 @ai00-x/design-system（./web 出口），经
   '@/component-library' re-export 消费；本地仅存应用组件。
   flowchat 工具卡演示已移除（业务组件在真实会话页查看，且其 barrel
   引入 preview 图谱会造成模块初始化环）。 */
import {
  Button, IconButton, Input, Search, Select, Checkbox, Switch, Textarea,
  Modal, CubeLoading, Alert, Tooltip, Tabs, TabPane, Tag, Badge,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuLabel,
  Popover, PopoverTrigger, PopoverContent,
  toast, toastSuccess, toastWarning, toastError,
  Progress, Skeleton, Separator, Avatar, Empty, ScrollArea,
  AlertDialog, AlertDialogTrigger, AlertDialogSimple,
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
  Drawer, DrawerTrigger, DrawerPanel,
  Pagination, Tree, type TreeNodeData,
} from '@/component-library';
import { Tooltip as DsTooltip } from '@ai00-x/design-system/react';
import { WindowControls } from '@/component-library';
import { Markdown } from '@components/Markdown';
import { CodeEditor } from '@components/CodeEditor';
import { BrandMark, Button as DsButton } from '@ai00-x/design-system/react';
import { DesignShowcase } from '../preview/DesignShowcase';

/** Tree demo 数据 */
const TREE_DEMO_NODES: TreeNodeData[] = [
  {
    id: 'src',
    label: 'src',
    children: [
      {
        id: 'src/web-ui',
        label: 'web-ui',
        children: [
          { id: 'src/web-ui/App.tsx', label: 'App.tsx' },
          { id: 'src/web-ui/main.tsx', label: 'main.tsx' },
        ],
      },
      {
        id: 'src/packages',
        label: 'packages',
        children: [{ id: 'src/packages/design-system', label: 'design-system' }],
      },
    ],
  },
  { id: 'AGENTS.md', label: 'AGENTS.md' },
  { id: 'pnpm-lock.yaml', label: 'pnpm-lock.yaml' },
];

/** Pagination demo（受控页码） */
const PaginationDemo: React.FC = () => {
  const [page, setPage] = React.useState(7);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Pagination page={page} total={20} onChange={setPage} />
      <span className="ds-data" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        第 {page} / 20 页
      </span>
    </div>
  );
};

/** 新东方极简·四签名示范页（活文档：规范 2.1–2.5 的可视参照） */
const SignatureShowcase: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 48, padding: '8px 16px 48px', maxWidth: 860 }}>
    {/* 签名一：黛青为神，朱砂为印 */}
    <section>
      <h2 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--color-text-primary)' }}>签名一 · 黛青为神，朱砂为印</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-muted)' }}>
        黛青是唯一交互色（可多处）；朱砂一屏一处（此处属于灵印）。主按钮黛青+纸白字（对比 5.69）。
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <DsButton variant="primary">主按钮 · 黛青</DsButton>
        <DsButton variant="default">次级</DsButton>
        <DsButton variant="ghost">幽灵</DsButton>
        <DsButton variant="destructive">危险</DsButton>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>↓ 朱砂印章按钮（全页唯一 CTA；本页已有灵印，实际页面应改黛青）</span>
        <DsButton variant="seal">开始生成</DsButton>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center' }}>
        <Badge variant="accent">黛青</Badge>
        <Badge variant="success">成功</Badge>
        <Badge variant="warning">警告</Badge>
        <Badge variant="error">错误</Badge>
        <Badge>中性</Badge>
      </div>
    </section>

    {/* 签名二：超大衬线标题 + 紧凑等宽数据 */}
    <section>
      <h2 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--color-text-primary)' }}>签名二 · 超大衬线标题 + 紧凑等宽数据</h2>
      <p className="ds-display" style={{ margin: '0 0 16px', fontSize: 'clamp(1.75rem,3vw,2.75rem)' }}>
        墨为骨 · 青为神 · 朱为印 · 白为息
      </p>
      <div style={{ display: 'flex', gap: 32 }}>
        <div>
          <div className="ds-data" style={{ fontSize: 28 }}>128,406</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>TOKENS · TABULAR</div>
        </div>
        <div>
          <div className="ds-data" style={{ fontSize: 28 }}>98.7%</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>成功率 · MONO</div>
        </div>
      </div>
    </section>

    {/* 签名三：宣纸颗粒 */}
    <section>
      <h2 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--color-text-primary)' }}>签名三 · 宣纸颗粒</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-muted)' }}>
        远看纯色，近看有材质。下方卡片为 L3 墨面 + 纸纹（.ds-card / .surface-paper）。
      </p>
      <div className="ds-card" style={{ maxWidth: 360, padding: 20 }}>
        <b style={{ fontSize: 14 }}>墨面卡片</b>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
          层次靠墨阶，不靠边框堆砌。
        </p>
      </div>
    </section>

    {/* 签名四：笔触与墨滴（白名单时刻） */}
    <section>
      <h2 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--color-text-primary)' }}>签名四 · 笔触与墨滴</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-muted)' }}>
        brush-reveal 用于标题进入/Tab 指示条/主题切换；ink-ripple 用于关键按钮反馈与 AI 生成起始。
        点击下方按钮后按钮短暂重播笔触入场。
      </p>
      <DsButton
        variant="primary"
        onClick={(e) => {
          const el = e.currentTarget as HTMLElement;
          el.classList.remove('ds-brush-reveal');
          void el.offsetWidth; // reflow 重置动画
          el.classList.add('ds-brush-reveal');
        }}
      >
        重播 brush-reveal
      </DsButton>
    </section>
  </div>
);



export const componentRegistry: ComponentCategory[] = [
  {
    id: 'showcase',
    name: '总览',
    description: '设计系统全组件总览（新东方极简 · 单页长卷）',
    layoutType: 'full-page',
    components: [
      {
        id: 'ds-showcase',
        name: 'DesignShowcase',
        description: '门面 + 令牌 + 23 组件',
        category: 'showcase',
        component: () => <DesignShowcase />,
      },
    ],
  },
  {
    id: 'design-system',
    name: '设计系统',
    description: 'Ai00-X 统一设计系统（@ai00-x/design-system · 新东方极简）',
    layoutType: 'grid-4',
    components: [
      {
        id: 'ds-brand-mark',
        name: 'BrandMark · 灵印',
        description: '品牌符号：seal 朱砂阳刻 / inverse 阴刻 / line 线稿 / lockup 落款',
        category: 'design-system',
        component: () => (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <BrandMark variant="seal" size={48} />
            <BrandMark variant="seal" size={32} />
            <BrandMark variant="seal" size={16} />
            <BrandMark variant="inverse" size={32} />
            <BrandMark variant="line" />
            <BrandMark variant="lockup" size={28} subtitle="Agentic OS" />
          </div>
        ),
      },
      {
        id: 'ds-button',
        name: 'Button · 黛青/朱砂',
        description: 'primary 黛青 / seal 朱砂印章（一屏一处）/ default / ghost / destructive',
        category: 'design-system',
        component: () => (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <DsButton variant="primary">Primary</DsButton>
            <DsButton variant="seal">Seal CTA</DsButton>
            <DsButton variant="default">Default</DsButton>
            <DsButton variant="ghost">Ghost</DsButton>
            <DsButton variant="destructive">Destructive</DsButton>
            <DsButton variant="primary" size="sm">Small</DsButton>
          </div>
        ),
      },
      {
        id: 'ds-input',
        name: 'Input · 黛青 focus',
        description: '沉底表面 + 黛青 focus ring',
        category: 'design-system',
        component: () => <Input placeholder="沉底输入框…" style={{ maxWidth: 220 }} />,
      },
      {
        id: 'ds-badge',
        name: 'Badge · 语义色',
        description: 'accent/success/warning/error/neutral',
        category: 'design-system',
        component: () => (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Badge variant="accent">accent</Badge>
            <Badge variant="success">success</Badge>
            <Badge variant="warning">warning</Badge>
            <Badge variant="error">error</Badge>
            <Badge>neutral</Badge>
          </div>
        ),
      },
    ],
  },
  {
    id: 'signatures',
    name: '四签名示范',
    description: '新东方极简四签名（签名色/排版/纹理/动效）——规范的活文档',
    layoutType: 'full-page',
    components: [
      {
        id: 'ds-signature-showcase',
        name: '四签名示范页',
        description: '墨为骨 · 青为神 · 朱为印 · 白为息',
        category: 'signatures',
        component: () => <SignatureShowcase />,
      },
    ],
  },
  {
    id: 'primitives',
    name: '交互原语',
    description: 'v0.13 扩展：浮层/反馈/展示原语（Radix + CVA · ds 系双出口）',
    layoutType: 'grid-4',
    components: [
      {
        id: 'ds-dropdown-menu',
        name: 'DropdownMenu · 下拉菜单',
        description: '.ds-menu 玻璃浮层；键盘导航 Radix 自带；destructive 危险项',
        category: 'primitives',
        component: () => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">打开菜单 ▾</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>操作</DropdownMenuLabel>
              <DropdownMenuItem>重命名</DropdownMenuItem>
              <DropdownMenuItem>复制链接</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive>删除</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
      {
        id: 'ds-popover',
        name: 'Popover · 锚定浮层',
        description: '.ds-popover 非模态；适合「锚点+面板」组合',
        category: 'primitives',
        component: () => (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost">锚点 ▾</Button>
            </PopoverTrigger>
            <PopoverContent style={{ width: 240 }}>
              <div style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>墨面浮层</div>
              <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-muted)' }}>
                非模态锚定：点击外部关闭，不阻断操作流。
              </div>
            </PopoverContent>
          </Popover>
        ),
      },
      {
        id: 'ds-tooltip-react',
        name: 'Tooltip · react 系',
        description: 'L4 玻璃小字 12px · delay 300ms（仅 ./react 出口）',
        category: 'primitives',
        component: () => (
          <div style={{ display: 'flex', gap: 12 }}>
            <DsTooltip content="黛青是唯一交互色">
              <Button variant="secondary">悬停看上</Button>
            </DsTooltip>
            <DsTooltip content="一句话以内，不承载操作" side="bottom">
              <Button variant="ghost">悬停看下</Button>
            </DsTooltip>
          </div>
        ),
      },
      {
        id: 'ds-toast',
        name: 'Toast · 命令式通知',
        description: 'toast()/toastSuccess()/toastWarning()/toastError()；语义色只表状态',
        category: 'primitives',
        component: () => (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => toast('模型已切换', { description: 'RWKV-7 World 2.9B' })}>Info</Button>
            <Button variant="secondary" onClick={() => toastSuccess('配置已保存')}>Success</Button>
            <Button variant="secondary" onClick={() => toastWarning('磁盘空间不足 10%')}>Warning</Button>
            <Button variant="secondary" onClick={() => toastError('连接失败', { description: 'ECONNREFUSED 127.0.0.1:8081' })}>Error</Button>
          </div>
        ),
      },
      {
        id: 'ds-progress',
        name: 'Progress · 进度',
        description: '黛青填充；语义变体仅表状态；高 6px 细条',
        category: 'primitives',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 320 }}>
            <Progress value={64} />
            <Progress value={100} variant="success" />
            <Progress value={32} variant="warning" />
            <Progress value={18} variant="error" />
          </div>
        ),
      },
      {
        id: 'ds-skeleton',
        name: 'Skeleton · 骨架',
        description: '墨阶底慢速脉冲（≈1.6s）；尺寸由消费方给',
        category: 'primitives',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 280 }}>
            <Skeleton style={{ height: 16, width: '60%' }} />
            <Skeleton style={{ height: 12, width: '100%' }} />
            <Skeleton style={{ height: 12, width: '85%' }} />
          </div>
        ),
      },
      {
        id: 'ds-separator',
        name: 'Separator · 分隔',
        description: '1px border.subtle；horizontal / vertical',
        category: 'primitives',
        component: () => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>墨</span>
            <Separator orientation="vertical" style={{ height: 24 }} />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>青</span>
            <Separator orientation="vertical" style={{ height: 24 }} />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>朱</span>
          </div>
        ),
      },
      {
        id: 'ds-avatar',
        name: 'Avatar · 头像',
        description: '圆形；失败回退墨阶圆底+首字；sm/base/lg/xl',
        category: 'primitives',
        component: () => (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Avatar name="灵" size="sm" />
            <Avatar name="Ai00" />
            <Avatar name="墨客" size="lg" />
            <Avatar name="X" size="xl" />
          </div>
        ),
      },
      {
        id: 'ds-empty',
        name: 'Empty · 墨韵空态',
        description: '大留白居中；默认灵印 line muted；action 唯一主行动',
        category: 'primitives',
        component: () => (
          <div style={{ border: '1px dashed var(--border-subtle)', borderRadius: 8, width: '100%' }}>
            <Empty description="还没有会话——落笔即开始" action={<Button variant="seal">新建会话</Button>} />
          </div>
        ),
      },
      {
        id: 'ds-scroll-area',
        name: 'ScrollArea · 滚动区',
        description: '8px 命中区 4px 墨阶 thumb；悬停显形',
        category: 'primitives',
        component: () => (
          <ScrollArea style={{ height: 120, width: '100%', maxWidth: 280, border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
            <div style={{ padding: 12, fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              {Array.from({ length: 16 }, (_, i) => (
                <div key={i}>松烟墨 第 {i + 1} 行 · 冷青 hue 240</div>
              ))}
            </div>
          </ScrollArea>
        ),
      },
      {
        id: 'ds-alert-dialog',
        name: 'AlertDialog · 确认框',
        description: 'L4 玻璃确认原语（组合式）；Action 可 destructive',
        category: 'primitives',
        component: () => (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">删除工作区…</Button>
            </AlertDialogTrigger>
            <AlertDialogSimple
              title="删除工作区？"
              description="此操作不可撤销，所有未提交的更改将永久丢失。"
              variant="destructive"
              actionText="永久删除"
            />
          </AlertDialog>
        ),
      },
    ],
  },
  {
    id: 'data-display',
    name: '数据展示',
    description: 'v0.13 扩展：Table/Tree/Drawer/Pagination（数据区组件）',
    layoutType: 'grid-4',
    components: [
      {
        id: 'ds-table',
        name: 'Table · 数据表',
        description: '组合式（不内建排序/分页）；dense 密度变体；数字列 .ds-data',
        category: 'data-display',
        component: () => (
          <Table dense style={{ width: '100%' }}>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead style={{ textAlign: 'right' }}>参数量</TableHead>
                <TableHead style={{ textAlign: 'right' }}>上下文</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>RWKV-7 World</TableCell>
                <TableCell className="ds-data" style={{ textAlign: 'right' }}>2.9B</TableCell>
                <TableCell className="ds-data" style={{ textAlign: 'right' }}>64k</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>RWKV-7 Goose</TableCell>
                <TableCell className="ds-data" style={{ textAlign: 'right' }}>19B</TableCell>
                <TableCell className="ds-data" style={{ textAlign: 'right' }}>128k</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>RWKV-8 试验</TableCell>
                <TableCell className="ds-data" style={{ textAlign: 'right' }}>1.5B</TableCell>
                <TableCell className="ds-data" style={{ textAlign: 'right' }}>32k</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ),
      },
      {
        id: 'ds-tree',
        name: 'Tree · 树形',
        description: '每级缩进 16px + guide line；chevron 旋转；选中黛青浅染',
        category: 'data-display',
        component: () => (
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 4, width: '100%' }}>
            <Tree
              defaultExpandedIds={['src']}
              nodes={TREE_DEMO_NODES}
              onSelect={(n) => toast(`选中：${String(n.label)}`)}
            />
          </div>
        ),
      },
      {
        id: 'ds-drawer',
        name: 'Drawer · 侧拉',
        description: 'Radix Dialog side 变体；滑入 0.3s；遮罩 + L4 玻璃',
        category: 'data-display',
        component: () => (
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant="secondary">打开侧拉面板</Button>
            </DrawerTrigger>
            <DrawerPanel title="会话详情" description="侧拉面板正文区可滚动">
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
                松烟墨 hue 240，与黛青 235° 同族一体——墨是青的沉睡态，青是墨的苏醒态。
                侧拉面板适用于详情、配置等非模态浏览场景。
              </p>
            </DrawerPanel>
          </Drawer>
        ),
      },
      {
        id: 'ds-pagination',
        name: 'Pagination · 分页',
        description: '页码 mono+tabular-nums；当前页黛青；与 Table 组合',
        category: 'data-display',
        component: () => (
          <PaginationDemo />
        ),
      },
    ],
  },
  {
    id: 'basic',
    name: '基础组件',
    description: '常用的基础UI组件',
    layoutType: 'grid-4',
    components: [
      {
        id: 'button-primary',
        name: 'Button - Primary',
        description: '主要按钮',
        category: 'basic',
        component: () => <Button variant="primary">Primary Button</Button>,
      },
      {
        id: 'button-secondary',
        name: 'Button - Secondary',
        description: '次要按钮',
        category: 'basic',
        component: () => <Button variant="secondary">Secondary Button</Button>,
      },
      {
        id: 'button-ghost',
        name: 'Button - Ghost',
        description: '幽灵按钮',
        category: 'basic',
        component: () => <Button variant="ghost">Ghost Button</Button>,
      },
      {
        id: 'button-sizes',
        name: 'Button - Sizes',
        description: 'Demo',
        category: 'basic',
        component: () => (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <Button size="small">Small</Button>
            <Button size="medium">Medium</Button>
            <Button size="large">Large</Button>
          </div>
        ),
      },
      {
        id: 'tag-demo',
        name: 'Tag - 演示',
        description: 'Demo',
        category: 'basic',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Tag color="blue">Blue</Tag>
              <Tag color="green">Green</Tag>
              <Tag color="red">Red</Tag>
              <Tag color="yellow">Yellow</Tag>
              <Tag color="purple">Purple</Tag>
              <Tag color="gray">Gray</Tag>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <Tag size="small">Small</Tag>
              <Tag size="medium">Medium</Tag>
              <Tag size="large">Large</Tag>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Tag color="blue" rounded>Rounded</Tag>
              <Tag color="green" closable onClose={() => alert('Closed!')}>Closable</Tag>
            </div>
          </div>
        ),
      },
      {
        id: 'icon-button-variants',
        name: 'IconButton - 变体',
        description: 'Demo',
        category: 'basic',
        component: () => (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <IconButton variant="default" aria-label="Search">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2"/>
                <path d="M11 11L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </IconButton>
            <IconButton variant="primary" aria-label="Star">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L10 6L14 6.5L11 9.5L12 14L8 11.5L4 14L5 9.5L2 6.5L6 6L8 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              </svg>
            </IconButton>
            <IconButton variant="ghost" aria-label="Settings">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="2"/>
                <path d="M8 1V3M8 13V15M15 8H13M3 8H1M13.5 2.5L12 4M4 12L2.5 13.5M13.5 13.5L12 12M4 4L2.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </IconButton>
            <IconButton variant="danger" aria-label="Delete">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 4H13M5 4V3C5 2.5 5.5 2 6 2H10C10.5 2 11 2.5 11 3V4M6 7V12M10 7V12M4 4L5 14H11L12 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </IconButton>
            <IconButton variant="success" aria-label="Check">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 8L6 11L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </IconButton>
            <IconButton variant="warning" aria-label="Warning">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L14 14H2L8 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                <path d="M8 6V9M8 11V11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </IconButton>
          </div>
        ),
      },
      {
        id: 'icon-button-sizes',
        name: 'IconButton - 尺寸',
        description: 'Demo',
        category: 'basic',
        component: () => (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <IconButton size="small" variant="primary" aria-label="Small">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L10 6L14 6.5L11 9.5L12 14L8 11.5L4 14L5 9.5L2 6.5L6 6L8 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              </svg>
            </IconButton>
            <IconButton size="medium" variant="primary" aria-label="Medium">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L10 6L14 6.5L11 9.5L12 14L8 11.5L4 14L5 9.5L2 6.5L6 6L8 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              </svg>
            </IconButton>
            <IconButton size="large" variant="primary" aria-label="Large">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L10 6L14 6.5L11 9.5L12 14L8 11.5L4 14L5 9.5L2 6.5L6 6L8 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              </svg>
            </IconButton>
          </div>
        ),
      },
      {
        id: 'icon-button-shapes',
        name: 'IconButton - 形状',
        description: 'Demo',
        category: 'basic',
        component: () => (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <IconButton shape="square" variant="primary" aria-label="Square">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="3" y="3" width="10" height="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </IconButton>
            <IconButton shape="circle" variant="primary" aria-label="Circle">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </IconButton>
          </div>
        ),
      },
      {
        id: 'window-controls-demo',
        name: 'WindowControls - 窗口控件',
        description: 'Demo',
        category: 'basic',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <WindowControls
                onMinimize={() => {}}
                onMaximize={() => {}}
                onClose={() => {}}
              />
            </div>
            <div>
              <WindowControls
                showMinimize={false}
                onMaximize={() => {}}
                onClose={() => {}}
              />
            </div>
            <div>
              <WindowControls
                showMaximize={false}
                onMinimize={() => {}}
                onClose={() => {}}
              />
            </div>
          </div>
        ),
      },
    ],
  },
  {
    id: 'feedback',
    name: '反馈组件',
    description: 'Demo',
    layoutType: 'demo',
    components: [
      {
        id: 'cube-loading-variants',
        name: 'CubeLoading - 所有变体',
        description: '3x3x3 立方体加载动画展示',
        category: 'feedback',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px', padding: '20px' }}>
            {}
            <div>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '16px', fontWeight: 500 }}>尺寸</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '48px', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                  <CubeLoading size="small" />
                  <span style={{ fontSize: '12px', color: '#999' }}>Small</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                  <CubeLoading size="medium" />
                  <span style={{ fontSize: '12px', color: '#999' }}>Medium</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                  <CubeLoading size="large" />
                  <span style={{ fontSize: '12px', color: '#999' }}>Large</span>
                </div>
              </div>
            </div>
            {}
            <div>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '16px', fontWeight: 500 }}>With text</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '48px', alignItems: 'flex-start' }}>
                <CubeLoading text="加载中.." />
                <CubeLoading size="large" text="加载中.." />
              </div>
            </div>
          </div>
        ),
      },
      {
        id: 'modal-basic',
        name: 'Modal - Basic',
        description: '基础弹窗',
        category: 'feedback',
        component: () => {
          const [isOpen, setIsOpen] = React.useState(false);
          return (
            <>
              <Button onClick={() => setIsOpen(true)}>打开弹窗</Button>
              <Modal
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
                title="基础弹窗"
              >
                <div style={{ padding: '16px' }}>
                  <p>Modal body content</p>
                </div>
              </Modal>
            </>
          );
        },
      },
      {
        id: 'alert-demo',
        name: 'Alert - 四种类型',
        description: 'Demo',
        category: 'feedback',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <Alert type="success" title="Success" message="Operation completed" closable />
            <Alert type="error" title="Error" message="Something went wrong" closable />
            <Alert type="warning" message="Warning message" />
            <Alert type="info" message="Info message" showIcon />
          </div>
        ),
      },
    ],
  },
  {
    id: 'form',
    name: '表单组件',
    description: '输入类表单组件',
    layoutType: 'grid-2',
    components: [
      {
        id: 'input-demo',
name: 'Input - Demo',
        description: 'Demo',
        category: 'form',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '400px' }}>
            <Input placeholder="Enter text" />
            <Input label="Label" placeholder="Placeholder" />
            <Input
              label="邮箱"
              type="email"
              placeholder="example@email.com"
              prefix="@"
            />
            <Input
              label="Password"
              type="password"
              placeholder="Enter password"
              error
              errorMessage="Error message"
            />
            <Input variant="filled" placeholder="Filled variant" />
            <Input variant="outlined" placeholder="Outlined variant" />
          </div>
        ),
      },
      {
        id: 'search-demo',
name: 'Search - Demo',
        description: 'Demo',
        category: 'form',
        component: () => {
          const [value, setValue] = React.useState('');
          const [loading, setLoading] = React.useState(false);
          const [searchOptions, setSearchOptions] = React.useState({
            caseSensitive: false,
            useRegex: false,
          });

          const handleSearch = (val: string) => {
            setLoading(true);
            setTimeout(() => {
              setLoading(false);
            }, 1500);
          };

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '500px' }}>
              <Search
                placeholder="搜索关键词.."
                onChange={(val) => setValue(val)}
              />
              <Search
                placeholder="Search"
                showSearchButton
                onSearch={handleSearch}
                loading={loading}
              />
              <Search
                placeholder="With suffix"
                suffixContent={
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      style={{
                        padding: '4px 6px',
                        background: searchOptions.caseSensitive ? 'rgba(96, 165, 250, 0.2)' : 'transparent',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        color: searchOptions.caseSensitive ? '#60a5fa' : '#a0a0a0',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                      onClick={() => setSearchOptions(prev => ({ ...prev, caseSensitive: !prev.caseSensitive }))}
                      title="Option"
                    >
                      Aa
                    </button>
                    <button
                      style={{
                        padding: '4px 6px',
                        background: searchOptions.useRegex ? 'rgba(96, 165, 250, 0.2)' : 'transparent',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        color: searchOptions.useRegex ? '#60a5fa' : '#a0a0a0',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                      onClick={() => setSearchOptions(prev => ({ ...prev, useRegex: !prev.useRegex }))}
                      title="Option"
                    >
                      .*
                    </button>
                  </div>
                }
              />
              <Search
                placeholder="Search..."
                expandOnFocus
              />
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <Search size="small" placeholder="Search" />
                <Search size="medium" placeholder="Search" />
                <Search size="large" placeholder="Search" />
              </div>
              <Search
                placeholder="Disabled"
                disabled
              />
              <Search
                placeholder="Error"
                error
                errorMessage="Error message"
              />
            </div>
          );
        },
      },
      {
        id: 'select-basic',
        name: 'Select - 基础选择',
        description: '基础单选和多选示例',
        category: 'form',
        component: () => {
          const [value, setValue] = React.useState<string | number>('');
          const [multiValue, setMultiValue] = React.useState<(string | number)[]>([]);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '400px' }}>
              <Select
                label="Select"
                options={[
                  { label: 'Option 1', value: '1' },
                  { label: 'Option 2', value: '2' },
                  { label: 'Option 3', value: '3' },
                  { label: 'Option 4', value: '4', disabled: true },
                ]}
                placeholder="Select..."
                value={value}
                onChange={(v) => setValue(v as string | number)}
                clearable
              />

              <Select
                label="Multiple"
                multiple
                showSelectAll
                options={[
                  { label: 'React', value: 'react' },
                  { label: 'Vue', value: 'vue' },
                  { label: 'Angular', value: 'angular' },
                  { label: 'Svelte', value: 'svelte' },
                  { label: 'Solid', value: 'solid' },
                ]}
                placeholder="选择技术"
                value={multiValue}
                onChange={(v) => setMultiValue(v as (string | number)[])}
                clearable
              />

              <div style={{ display: 'flex', gap: '12px', flexDirection: 'column' }}>
                <Select
                  size="small"
                  options={[
                    { label: 'Small', value: 's1' },
                    { label: 'Option 2', value: 's2' },
                  ]}
                  placeholder="Small size"
                />
                <Select
                  size="large"
                  options={[
                    { label: 'Large', value: 'l1' },
                    { label: 'Option 2', value: 'l2' },
                  ]}
                  placeholder="Large size"
                />
              </div>
            </div>
          );
        },
      },
      {
        id: 'select-searchable',
        name: 'Select - Demo',
        description: '可搜索的选择器示例',
        category: 'form',
        component: () => {
          const [value, setValue] = React.useState<string | number>('');

          const countries = [
            { label: 'CN', value: 'cn', description: 'China' },
            { label: 'US', value: 'us', description: 'United States' },
            { label: 'JP', value: 'jp', description: 'Japan' },
            { label: 'UK', value: 'uk', description: 'United Kingdom' },
            { label: 'FR', value: 'fr', description: 'France' },
            { label: 'DE', value: 'de', description: 'Germany' },
            { label: 'CA', value: 'ca', description: 'Canada' },
            { label: 'AU', value: 'au', description: 'Australia' },
            { label: 'KR', value: 'kr', description: 'Korea' },
            { label: 'SG', value: 'sg', description: 'Singapore' },
          ];

          return (
            <div style={{ maxWidth: '400px' }}>
              <Select
                label="Country"
                searchable
                searchPlaceholder="Search..."
                options={countries}
                placeholder="Select..."
                value={value}
                onChange={(v) => setValue(v as string | number)}
                clearable
              />
            </div>
          );
        },
      },
      {
        id: 'select-grouped',
        name: 'Select - 分组选择',
        description: '带分组的选择器',
        category: 'form',
        component: () => {
          const [value, setValue] = React.useState<string | number>('');

          const options = [
            { label: 'React', value: 'react', group: 'Frontend' },
            { label: 'Vue', value: 'vue', group: 'Frontend' },
            { label: 'Angular', value: 'angular', group: 'Frontend' },
            { label: 'Node.js', value: 'nodejs', group: 'Backend' },
            { label: 'Deno', value: 'deno', group: 'Backend' },
            { label: 'Express', value: 'express', group: 'Backend' },
            { label: 'PostgreSQL', value: 'postgresql', group: 'Database' },
            { label: 'MongoDB', value: 'mongodb', group: 'Database' },
            { label: 'Redis', value: 'redis', group: 'Database' },
          ];

          return (
            <div style={{ maxWidth: '400px' }}>
              <Select
                label="选择框架"
                searchable
                options={options}
                placeholder="选择..."
                value={value}
                onChange={(v) => setValue(v as string | number)}
                clearable
              />
            </div>
          );
        },
      },
      {
        id: 'select-with-icons',
        name: 'Select - Demo',
        description: '带图标的选择器',
        category: 'form',
        component: () => {
          const [value, setValue] = React.useState<string | number>('');

          const options = [
            {
              label: 'TypeScript',
              value: 'ts',
              description: 'TypeScript language',
              icon: <span style={{ fontSize: '18px' }}>TS</span>
            },
            {
              label: 'JavaScript',
              value: 'js',
              description: 'JavaScript language',
              icon: <span style={{ fontSize: '18px' }}>JS</span>
            },
            {
              label: 'Python',
              value: 'py',
              description: 'Python language',
              icon: <span style={{ fontSize: '18px' }}>PY</span>
            },
            {
              label: 'Rust',
              value: 'rs',
              description: 'Rust language',
              icon: <span style={{ fontSize: '18px' }}>RS</span>
            },
            {
              label: 'Go',
              value: 'go',
              description: 'Go language',
              icon: <span style={{ fontSize: '18px' }}>GO</span>
            },
          ];

          return (
            <div style={{ maxWidth: '400px' }}>
              <Select
                label="Language"
                searchable
                options={options}
                placeholder="Select..."
                value={value}
                onChange={(v) => setValue(v as string | number)}
                clearable
              />
            </div>
          );
        },
      },
      {
        id: 'select-advanced',
        name: 'Select - Demo',
        description: '加载、错误和禁用状态',
        category: 'form',
        component: () => {
          const [value1, setValue1] = React.useState<string | number>('');
          const [value2, setValue2] = React.useState<string | number>('');

          const options = [
            { label: 'Option 1', value: '1' },
            { label: 'Option 2', value: '2' },
            { label: 'Option 3', value: '3' },
          ];

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '400px' }}>
              <Select
                label="Loading"
                loading
                options={options}
                placeholder="Loading..."
                value={value1}
                onChange={(v) => setValue1(v as string | number)}
              />

              <Select
                label="Error"
                error
                errorMessage="Error message"
                options={options}
                placeholder="Error"
                value={value2}
                onChange={(v) => setValue2(v as string | number)}
              />

              <Select
                label="Disabled"
                disabled
                options={options}
                placeholder="Placeholder"
              />
            </div>
          );
        },
      },
      {
        id: 'checkbox-demo',
        name: 'Checkbox - Demo',
        description: '复选框演示',
        category: 'form',
        component: () => {
          const [checked, setChecked] = React.useState(false);
          const [indeterminate, setIndeterminate] = React.useState(true);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <Checkbox label="Option" />
              <Checkbox
                label="Option"
                description="Description"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <Checkbox
                label="Indeterminate"
                indeterminate={indeterminate}
                onChange={() => setIndeterminate(false)}
              />
              <Checkbox label="Option" disabled />
              <Checkbox label="Option" error />
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <Checkbox size="small" label="Small" />
                <Checkbox size="medium" label="Medium" />
                <Checkbox size="large" label="Large" />
              </div>
            </div>
          );
        },
      },
      {
        id: 'switch-demo',
        name: 'Switch - Demo',
        description: 'Demo',
        category: 'form',
        component: () => {
          const [checked, setChecked] = React.useState(false);
          const [loading, setLoading] = React.useState(false);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <Switch label="Option" />
              <Switch
                label="Option"
                description="Description"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <Switch
                label="Loading"
                loading={loading}
                checked={loading}
                onChange={(e) => {
                  setLoading(true);
                  setTimeout(() => setLoading(false), 2000);
                }}
              />
              <Switch label="Option" disabled />
              <Switch
                checkedText="ON"
                uncheckedText="OFF"
                label="With labels"
              />
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <Switch size="small" />
                <Switch size="medium" />
                <Switch size="large" />
              </div>
            </div>
          );
        },
      },
      {
        id: 'textarea-demo',
        name: 'Textarea - Demo',
        description: 'Demo',
        category: 'form',
        component: () => {
          const [value, setValue] = React.useState('');

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '500px' }}>
              <Textarea
                label="Label"
                placeholder="Placeholder..."
              />
              <Textarea
                label="字数限制"
                placeholder="最多100字符.."
                showCount
                maxLength={100}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <Textarea
                label="自动调整高度"
                placeholder="内容会自动调整高度..."
                autoResize
              />
              <Textarea
                label="Error"
                error
                errorMessage="请输入有效内容"
                placeholder="输入内容.."
              />
              <Textarea
                variant="filled"
                placeholder="Filled variant"
              />
              <Textarea
                variant="outlined"
                placeholder="Outlined variant"
              />
            </div>
          );
        },
      },
    ],
  },
  {
    id: 'content',
    name: '内容组件',
    description: '展示内容和媒体的组件',
    layoutType: 'large-card',
    components: [
      {
        id: 'markdown-viewer',
        name: 'Markdown Demo',
description: 'Markdown with GFM support',
        category: 'content',
        component: () => (
          <Markdown
            content={`# Markdown 演示

这是一个**Markdown**渲染示例

## 功能

- 代码高亮
- GFM 支持
- 数学公式
- 表格支持

\`\`\`js
console.log('Hello, Ai00-X!');
\`\`\`

> 引用块示例`}
          />
        ),
      },
      {
        id: 'code-editor',
        name: 'CodeEditor',
        description: '基于 Monaco Editor 的代码编辑器',
        category: 'content',
        component: () => {
          const [code, setCode] = React.useState(`// TypeScript 示例
interface User {
  name: string;
  age: number;
  email?: string;
}

class Person implements User {
  constructor(
    public name: string,
    public age: number,
    public email?: string
  ) {}

  greet(): string {
    return \`Hello, I'm \${this.name}\`;
  }
}

const user = new Person("Alice", 25);
console.log(user.greet());`);

          return (
            <div style={{ width: '100%' }}>
              <CodeEditor
                value={code}
                language="typescript"
                height="350px"
                minimap={false}
                lineNumbers="on"
                onChange={(value) => setCode(value || '')}
              />
            </div>
          );
        },
      },
    ],
  },
  {
    id: 'navigation',
    name: '导航组件',
    description: 'Demo',
    layoutType: 'grid-2',
    components: [
      {
        id: 'tabs-demo',
        name: 'Tabs - Demo',
        description: 'Demo',
        category: 'navigation',
        component: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <Tabs type="line" defaultActiveKey="1">
              <TabPane tabKey="1" label="Tab 1">
                <div style={{ padding: '16px' }}>Line 类型 - 内容1</div>
              </TabPane>
              <TabPane tabKey="2" label="Tab 2">
                <div style={{ padding: '16px' }}>Line 类型 - 内容2</div>
              </TabPane>
              <TabPane tabKey="3" label="Tab 3">
                <div style={{ padding: '16px' }}>Line 类型 - 内容3</div>
              </TabPane>
            </Tabs>

            <Tabs type="card" defaultActiveKey="1">
              <TabPane tabKey="1" label="Card 1">
                <div style={{ padding: '16px' }}>Card 类型 - 内容1</div>
              </TabPane>
              <TabPane tabKey="2" label="Card 2">
                <div style={{ padding: '16px' }}>Card 类型 - 内容2</div>
              </TabPane>
            </Tabs>

            <Tabs type="pill" defaultActiveKey="1">
              <TabPane tabKey="1" label="Pill 1">
                <div style={{ padding: '16px' }}>Pill 类型 - 内容1</div>
              </TabPane>
              <TabPane tabKey="2" label="Pill 2">
                <div style={{ padding: '16px' }}>Pill 类型 - 内容2</div>
              </TabPane>
            </Tabs>
          </div>
        ),
      },
    ],
  },
  {
    id: 'advanced-feedback',
    name: '高级反馈',
    description: '高级反馈组件',
    layoutType: 'grid-3',
    components: [
      {
        id: 'tooltip-demo',
        name: 'Tooltip - 位置演示',
        description: '气泡提示',
        category: 'advanced-feedback',
        component: () => (
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center', padding: '40px' }}>
            <Tooltip content="上方提示" placement="top">
              <Button>Top</Button>
            </Tooltip>
            <Tooltip content="下方提示" placement="bottom">
              <Button>Bottom</Button>
            </Tooltip>
            <Tooltip content="左侧提示" placement="left">
              <Button>Left</Button>
            </Tooltip>
            <Tooltip content="右侧提示" placement="right">
              <Button>Right</Button>
            </Tooltip>
          </div>
        ),
      },
    ],
  },
];

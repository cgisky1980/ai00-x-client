/**
 * Ai00-UI 文档数据 —— 组件分组 / 使用说明 / API 表 / 代码示例
 * API 数据转录自 packages/design-system/llms.txt（机器可读清单，单一事实来源）。
 */

export interface ApiRow {
  param: string;
  desc: string;
  type: string;
  default?: string;
  /** 标记必填（展示在说明列） */
  required?: boolean;
}

export interface ComponentDoc {
  id: string;
  title: string;
  en: string;
  desc: string;
  usage?: string[];
  api?: ApiRow[];
  code: string;
}

export interface DocGroup {
  id: string;
  title: string;
  components: ComponentDoc[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    id: 'general',
    title: '通用',
    components: [
      {
        id: 'button',
        title: '按钮 Button',
        en: 'Button',
        desc: '行为触发器。主行动用 primary（黛青实体），破坏性操作用 danger；seal（朱砂）仅 ds 系、一屏一处。',
        usage: [
          '主按钮一屏一个（primary），次级用 secondary/ghost，弱操作用 dashed',
          'isLoading 内置换行内加载，禁用态自动处理',
          'ds 系另有 seal（朱砂 CTA）与 destructive 变体',
        ],
        api: [
          { param: 'variant', desc: '视觉变体', type: "'primary' | 'secondary' | 'ghost' | 'dashed' | 'danger' | 'success' | 'accent' | 'ai'", default: "'primary'" },
          { param: 'size', desc: '尺寸', type: "'small' | 'medium' | 'large'", default: "'medium'" },
          { param: 'isLoading', desc: '加载态（禁用 + 行内 spinner）', type: 'boolean', default: 'false' },
          { param: 'iconOnly', desc: '纯图标按钮（方形 padding）', type: 'boolean', default: 'false' },
          { param: '...rest', desc: '透传原生 button 属性', type: 'ButtonHTMLAttributes' },
        ],
        code: `import { Button } from '@ai00-x/design-system/web';

<Button variant="primary">主按钮</Button>
<Button variant="secondary" size="small">次级</Button>
<Button isLoading>提交中</Button>`,
      },
      {
        id: 'icon-button',
        title: '图标按钮 IconButton',
        en: 'IconButton',
        desc: '纯图标操作位。tooltip 属性内置悬浮说明（followCursor），并自动兜底 aria-label 无障碍名。',
        usage: [
          '必须给 tooltip 或 aria-label（读屏可访问名）',
          'variant=ghost 用于工具栏低干扰操作',
          'shape=circle 适合浮动动作位',
        ],
        api: [
          { param: 'variant', desc: '变体', type: "'default' | 'primary' | 'ghost' | 'danger' | 'success' | 'warning' | 'ai'", default: "'default'" },
          { param: 'size', desc: '尺寸（含 xs）', type: "'xs' | 'small' | 'medium' | 'large'", default: "'medium'" },
          { param: 'shape', desc: '形状', type: "'square' | 'circle'", default: "'square'" },
          { param: 'tooltip', desc: '悬浮提示（string 时兜底 aria-label）', type: 'ReactNode' },
          { param: 'tooltipFollowCursor', desc: '提示跟随光标', type: 'boolean', default: 'true' },
        ],
        code: `import { IconButton } from '@ai00-x/design-system/web';
import { Copy } from 'lucide-react';

<IconButton tooltip="复制" onClick={copy}><Copy size={16} /></IconButton>`,
      },
      {
        id: 'tag',
        title: '标签 Tag',
        en: 'Tag',
        desc: '轻量分类标记。⚠️ 颜色属性名为 color（非 variant）。',
        usage: [
          '用于状态/分类的静态标记，非操作入口',
          'closable 配 onClose 支持移除',
        ],
        api: [
          { param: 'color', desc: '色系（注意属性名是 color）', type: "'blue' | 'green' | 'red' | 'yellow' | 'purple' | 'gray'", default: 'gray' },
          { param: 'closable', desc: '可关闭', type: 'boolean', default: 'false' },
          { param: 'onClose', desc: '关闭回调', type: '(e) => void' },
          { param: 'rounded', desc: '全圆角', type: 'boolean' },
        ],
        code: `import { Tag } from '@ai00-x/design-system/web';

<Tag color="blue">进行中</Tag>
<Tag color="green" closable onClose={() => {}}>可移除</Tag>`,
      },
      {
        id: 'badge',
        title: '徽标 Badge',
        en: 'Badge',
        desc: '无边框语义底色状态标（成功/警告/错误/信息），比 Tag 更安静。',
        usage: ['表达运行状态（非交互）', '语义色只表状态，不做装饰'],
        api: [
          { param: 'variant', desc: '语义变体', type: "'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'info'", default: "'neutral'" },
        ],
        code: `import { Badge } from '@ai00-x/design-system/web';

<Badge variant="success">stable</Badge>`,
      },
      {
        id: 'brand-mark',
        title: '灵印 BrandMark',
        en: 'BrandMark',
        desc: '品牌符号：seal 朱砂阳刻（默认门面）/ ink 墨色 / inverse 阴刻 / line 线稿 / lockup 落款组合。',
        usage: [
          'animated（灵韵态：呼吸+眨眼）仅用于 loading/启动场景',
          'seal 朱砂一屏一处（规范 2.1）',
        ],
        api: [
          { param: 'variant', desc: '样式', type: "'ink' | 'seal' | 'inverse' | 'line' | 'lockup'", default: "'ink'" },
          { param: 'size', desc: '像素尺寸', type: 'number', default: '24' },
          { param: 'animated', desc: '灵韵态动画', type: 'boolean', default: 'false' },
          { param: 'subtitle', desc: 'lockup 副标题', type: 'string' },
        ],
        code: `import { BrandMark } from '@ai00-x/design-system/react';

<BrandMark variant="seal" size={48} animated />`,
      },
    ],
  },
  {
    id: 'data-entry',
    title: '数据录入',
    components: [
      {
        id: 'input',
        title: '输入框 Input',
        en: 'Input',
        desc: '文本录入。沉底表面 + 黛青 focus；⚠️ 尺寸属性名为 inputSize（size 为别名且优先）。',
        usage: ['错误态用 error + errorMessage 成对出现', '前缀/后缀用 prefix/suffix 插槽'],
        api: [
          { param: 'inputSize', desc: '尺寸', type: "'small' | 'medium' | 'large'", default: "'medium'" },
          { param: 'variant', desc: '表面变体', type: "'default' | 'filled' | 'outlined'", default: "'default'" },
          { param: 'error / errorMessage', desc: '错误态与文案', type: 'boolean / string' },
          { param: 'prefix / suffix', desc: '前后缀插槽', type: 'ReactNode' },
          { param: 'label / hint', desc: '标签与提示', type: 'string' },
        ],
        code: `import { Input } from '@ai00-x/design-system/web';

<Input label="项目名" placeholder="输入…" prefix="@" />
<Input error errorMessage="不可为空" />`,
      },
      {
        id: 'textarea',
        title: '多行文本 Textarea',
        en: 'Textarea',
        desc: '长文本录入，支持自动增高与字数统计。',
        usage: ['autoResize 随内容增高', 'showCount + maxLength 显示计数'],
        api: [
          { param: 'autoResize', desc: '自动增高', type: 'boolean', default: 'false' },
          { param: 'showCount', desc: '显示计数', type: 'boolean', default: 'false' },
          { param: 'maxLength', desc: '最大长度', type: 'number' },
          { param: 'label / hint / error / errorMessage', desc: '同 Input', type: 'string / boolean' },
        ],
        code: `import { Textarea } from '@ai00-x/design-system/web';

<Textarea label="描述" autoResize showCount maxLength={200} />`,
      },
      {
        id: 'search',
        title: '搜索框 Search',
        en: 'Search',
        desc: '带搜索按钮与清空的搜索录入，enter 触发。',
        usage: ['受控 value + onSearch 拿最终查询词', 'expandOnFocus 聚焦展开（工具栏场景）'],
        api: [
          { param: 'onSearch', desc: '搜索回调（enter/按钮）', type: '(value) => void' },
          { param: 'loading', desc: '搜索中态', type: 'boolean' },
          { param: 'showSearchButton', desc: '显示搜索按钮', type: 'boolean' },
          { param: 'expandOnFocus', desc: '聚焦展开', type: 'boolean', default: 'false' },
          { param: 'clearable', desc: '可清空', type: 'boolean', default: 'true' },
        ],
        code: `import { Search } from '@ai00-x/design-system/web';

<Search placeholder="搜索组件…" onSearch={(v) => query(v)} />`,
      },
      {
        id: 'select',
        title: '选择器 Select',
        en: 'Select',
        desc: '单选/多选/搜索/全选/自定义值全能力下拉；E3a 后键盘与读屏完整（combobox 模式）。',
        usage: [
          'multiple 时 value/onChange 均为数组',
          'allowCustomValue 允许搜索词直接成值（仅单选 + searchable）',
          '分组用 option.group 字段',
        ],
        api: [
          { param: 'options', desc: '选项', type: '{label, value, disabled?, description?, icon?, group?}[]', required: true },
          { param: 'multiple', desc: '多选（值为数组）', type: 'boolean', default: 'false' },
          { param: 'searchable', desc: '可搜索过滤', type: 'boolean', default: 'false' },
          { param: 'showSelectAll', desc: '多选全选行', type: 'boolean', default: 'false' },
          { param: 'clearable', desc: '可清空', type: 'boolean', default: 'false' },
          { param: 'allowCustomValue', desc: '自定义值（单选+搜索）', type: 'boolean', default: 'false' },
          { param: 'maxTagCount', desc: '多选标签最多展示数', type: 'number', default: '3' },
        ],
        code: `import { Select } from '@ai00-x/design-system/web';

<Select
  options={[{ label: '黛青', value: 'accent' }, { label: '朱砂', value: 'seal' }]}
  searchable clearable
  onChange={(v) => setV(v)}
/>`,
      },
      {
        id: 'checkbox',
        title: '复选框 Checkbox',
        en: 'Checkbox',
        desc: '多项选择控件，原生 input 为底（Space 切换），支持半选播报。',
        usage: ['indeterminate 表示部分选中（aria-checked=mixed）', 'label/description 与控件自动关联'],
        api: [
          { param: 'indeterminate', desc: '半选态', type: 'boolean', default: 'false' },
          { param: 'label / description', desc: '标签与说明', type: 'ReactNode / string' },
          { param: 'error', desc: '错误态', type: 'boolean' },
          { param: '...rest', desc: '透传原生 input 属性（checked/onChange）', type: 'InputHTMLAttributes' },
        ],
        code: `import { Checkbox } from '@ai00-x/design-system/web';

<Checkbox label="记住偏好" checked={v} onChange={(e) => setV(e.target.checked)} />`,
      },
      {
        id: 'switch',
        title: '开关 Switch',
        en: 'Switch',
        desc: '二元即时切换（role=switch），适合设置项而非表单提交。',
        usage: ['checkedText/uncheckedText 展示开合文案', 'loading 时自动禁用'],
        api: [
          { param: 'checked / onChange', desc: '受控值', type: 'boolean' },
          { param: 'loading', desc: '加载态', type: 'boolean', default: 'false' },
          { param: 'checkedText / uncheckedText', desc: '开/关文案', type: 'string' },
          { param: 'label / description', desc: '标签与说明', type: 'string' },
        ],
        code: `import { Switch } from '@ai00-x/design-system/web';

<Switch label="智能路由" checked={on} onChange={(e) => setOn(e.target.checked)} />`,
      },
      {
        id: 'number-input',
        title: '数字输入 NumberInput',
        en: 'NumberInput',
        desc: '数值录入（spinbutton 语义）：键盘 ↑↓、滚轮、拖拽调值三通道。',
        usage: ['draggable 开启纵向拖拽调值', 'min/max 自动夹取；precision 控制小数位'],
        api: [
          { param: 'value / onChange', desc: '受控数值', type: 'number' },
          { param: 'min / max / step', desc: '边界与步长', type: 'number' },
          { param: 'unit', desc: '单位后缀（aria-valuetext）', type: 'string' },
          { param: 'variant', desc: 'default / compact / stepper', type: 'string', default: "'default'" },
          { param: 'draggable', desc: '拖拽调值', type: 'boolean', default: 'false' },
        ],
        code: `import { NumberInput } from '@ai00-x/design-system/web';

<NumberInput value={n} onChange={setN} min={0} max={100} unit="%" />`,
      },
      {
        id: 'star-rating',
        title: '评分 StarRating',
        en: 'StarRating',
        desc: '星级评分（radiogroup + roving tabindex）。⚠️ 尺寸枚举为 sm/md/lg。',
        usage: ['受控 value + onChange', '键盘 ←→ 调整，读屏播报星级'],
        api: [
          { param: 'value / onChange', desc: '受控分值', type: 'number' },
          { param: 'maxStars', desc: '星数上限', type: 'number', default: '5' },
          { param: 'size', desc: '尺寸（⚠️ sm/md/lg）', type: "'sm' | 'md' | 'lg'", default: "'md'" },
        ],
        code: `import { StarRating } from '@ai00-x/design-system/web';

<StarRating value={4} onChange={setStar} label="评分" />`,
      },
    ],
  },
  {
    id: 'data-display',
    title: '数据展示',
    components: [
      {
        id: 'card',
        title: '卡片 Card',
        en: 'Card',
        desc: '实体墨面容器（禁玻璃拟态）。层次靠墨阶变体，不靠边框堆砌。',
        usage: [
          'variant：default 墨面 / elevated 浮起 / subtle 沉底 / accent 青染选中',
          'interactive 加 hover 上浮（可点击场景）',
          '复合式：Card/Header/Body/Footer',
        ],
        api: [
          { param: 'variant', desc: '表面变体', type: "'default' | 'elevated' | 'subtle' | 'accent' | 'purple'", default: "'default'" },
          { param: 'interactive', desc: '可交互（hover 上浮）', type: 'boolean', default: 'false' },
          { param: 'padding', desc: '内边距', type: "'none' | 'small' | 'medium' | 'large'", default: "'medium'" },
        ],
        code: `import { Card } from '@ai00-x/design-system/web';

<Card interactive>
  <p>可点击卡片</p>
</Card>`,
      },
      {
        id: 'table',
        title: '表格 Table',
        en: 'Table',
        desc: '组合式数据表（Table/Header/Body/Row/Head/Cell）；密度档 dense，数字列套 .ds-data（mono+tabular）。',
        usage: ['无内建排序/分页——与 Pagination 组合', 'dense 用于数据密集区（规范：密度只出现在数据区）'],
        api: [
          { param: 'dense', desc: '紧凑密度', type: 'boolean', default: 'false' },
          { param: 'TableHead / TableCell', desc: '单元格内容', type: 'ReactNode' },
        ],
        code: `import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@ai00-x/design-system/web';

<Table dense>
  <TableHeader><TableRow><TableHead>令牌</TableHead></TableRow></TableHeader>
  <TableBody><TableRow><TableCell className="ds-data">--accent-500</TableCell></TableRow></TableBody>
</Table>`,
      },
      {
        id: 'tree',
        title: '树 Tree',
        en: 'Tree',
        desc: '层级导航（非虚拟化）；大列表配合 react-virtuoso 组合使用。',
        usage: ['defaultExpandedIds 控制初始展开', 'renderLabel 自定义节点渲染'],
        api: [
          { param: 'nodes', desc: '节点数据', type: '{id, label, children?, icon?, actions?}[]', required: true },
          { param: 'defaultExpandedIds', desc: '初始展开', type: 'string[]' },
          { param: 'selectedId / onSelect', desc: '选中受控', type: 'string / (node) => void' },
        ],
        code: `import { Tree } from '@ai00-x/design-system/web';

<Tree nodes={nodes} defaultExpandedIds={['src']} onSelect={(n) => go(n.id)} />`,
      },
      {
        id: 'pagination',
        title: '分页 Pagination',
        en: 'Pagination',
        desc: '页码导航，页码 mono+tabular-nums。',
        usage: ['page/total/onChange 三件套', 'siblingCount 控制当前页两侧页码数'],
        api: [
          { param: 'page', desc: '当前页', type: 'number', required: true },
          { param: 'total', desc: '总页数', type: 'number', required: true },
          { param: 'onChange', desc: '翻页回调', type: '(page) => void', required: true },
          { param: 'siblingCount', desc: '两侧页码数', type: 'number', default: '1' },
        ],
        code: `import { Pagination } from '@ai00-x/design-system/web';

<Pagination page={p} total={20} onChange={setP} />`,
      },
      {
        id: 'timeline',
        title: '时间线 Timeline',
        en: 'Timeline',
        desc: '竖向时间线：节点三态流转（finish 勾线黛青 / active 实心呼吸 / pending 墨点），时间列 mono+tabular。',
        usage: ['时间列由 time prop 直出（数字/时间戳走 mono）', 'status 三态表达进度语义，勿用色彩装饰', '末项自动断线；dot 可替换自定义节点'],
        api: [
          { param: 'time', desc: '左列时间戳', type: 'ReactNode' },
          { param: 'title / description', desc: '标题与描述', type: 'ReactNode' },
          { param: 'status', desc: '节点状态', type: "'finish' | 'active' | 'pending'", default: "'pending'" },
          { param: 'dot', desc: '自定义节点（替代圆点）', type: 'ReactNode' },
        ],
        code: `import { Timeline, TimelineItem } from '@ai00-x/design-system/web';

<Timeline>
  <TimelineItem time="08:30" title="音乐电台" description="AI 按节奏挑好曲子" status="finish" />
  <TimelineItem time="09:00" title="专注工作" status="active" />
  <TimelineItem time="23:00" title="晚安" />
</Timeline>`,
      },
      {
        id: 'statistic',
        title: '数字统计 Statistic',
        en: 'Statistic',
        desc: '数值展示 + count-up 滚动动画（值变化 600ms easeOutCubic）；数字 mono+tabular-nums。',
        usage: ['仪表盘 KPI / 名额 / 计数场景', 'reduced-motion 用户自动直出终值', 'motion=false 关闭动画（高频刷新场景）'],
        api: [
          { param: 'value', desc: '数值', type: 'number', required: true },
          { param: 'title / prefix / suffix', desc: '标题与前後缀', type: 'ReactNode' },
          { param: 'precision', desc: '小数位', type: 'number', default: '0' },
          { param: 'groupSeparator', desc: '千分位符（空串关闭）', type: 'string', default: "','" },
          { param: 'motion', desc: 'count-up 动画', type: 'boolean', default: 'true' },
        ],
        code: `import { Statistic } from '@ai00-x/design-system/web';

<Statistic title="剩余名额" value={quota} suffix=" 个" />`,
      },
      {
        id: 'collapse',
        title: '折叠面板 Collapse',
        en: 'Collapse',
        desc: '分组收纳长内容；grid-rows 高度过渡（无 max-height 魔数），a11y 完整（aria-expanded + region）。',
        usage: ['accordion=true 手风琴（同时只开一个）', '受控 activeKeys / 非受控 defaultActiveKeys', 'disabled 整项禁用'],
        api: [
          { param: 'defaultActiveKeys', desc: '初始展开项', type: 'Array<string | number>' },
          { param: 'activeKeys / onChange', desc: '受控展开项与回调', type: 'Array / (keys) => void' },
          { param: 'accordion', desc: '手风琴模式', type: 'boolean', default: 'false' },
          { param: 'CollapseItem: itemKey / header', desc: '项键与头内容', type: 'string | number / ReactNode', required: true },
        ],
        code: `import { Collapse, CollapseItem } from '@ai00-x/design-system/web';

<Collapse defaultActiveKeys={['a']}>
  <CollapseItem itemKey="a" header="什么是 Vibe OS？">好氛围 + 高效工具集。</CollapseItem>
  <CollapseItem itemKey="b" header="本地优先？">数据不出机器。</CollapseItem>
</Collapse>`,
      },
      {
        id: 'steps',
        title: '步骤条 Steps',
        en: 'Steps',
        desc: '横向流程步骤：finish 勾 / process 实心呼吸 / wait 墨阶；连接线随完成流转黛青。',
        usage: ['current 之前全部 finish，之后 wait', '窄屏（≤640px）自动纵排', 'description 可选副文本'],
        api: [
          { param: 'steps', desc: '步骤数据', type: '{title, description?}[]', required: true },
          { param: 'current', desc: '当前步索引（0 起）', type: 'number', required: true },
        ],
        code: `import { Steps } from '@ai00-x/design-system/web';

<Steps current={1} steps={[
  { title: '抢资格', description: '每小时 20 名' },
  { title: '填问卷', description: '10 分钟内' },
  { title: '收邀请码', description: '发到邮箱' },
]} />`,
      },
      {
        id: 'avatar',
        title: '头像 Avatar',
        en: 'Avatar',
        desc: '用户/实体头像，无图时 name 首字兜底。',
        api: [
          { param: 'src / alt', desc: '图片源', type: 'string' },
          { param: 'name', desc: '兜底名（取首字）', type: 'string' },
          { param: 'size', desc: '尺寸', type: "'sm' | 'base' | 'lg' | 'xl'", default: "'base'" },
        ],
        code: `import { Avatar } from '@ai00-x/design-system/web';

<Avatar name="Ai00-X" />`,
      },
      {
        id: 'empty',
        title: '空状态 Empty',
        en: 'Empty',
        desc: '空数据占位：默认灵印 line + label() 文案，action 放唯一主行动。',
        usage: ['大留白居中，勿塞过多元素'],
        api: [
          { param: 'title / description', desc: '标题与描述', type: 'string' },
          { param: 'icon', desc: '自定义图标', type: 'ReactNode' },
          { param: 'action', desc: '行动按钮（唯一主行动）', type: 'ReactNode' },
        ],
        code: `import { Empty, Button } from '@ai00-x/design-system/web';

<Empty description="暂无会话" action={<Button>新建会话</Button>} />`,
      },
      {
        id: 'progress',
        title: '进度条 Progress',
        en: 'Progress',
        desc: '线性进度，语义色变体表状态。',
        api: [
          { param: 'value', desc: '进度 0–100', type: 'number' },
          { param: 'variant', desc: '状态色', type: "'default' | 'success' | 'warning' | 'error'", default: "'default'" },
        ],
        code: `import { Progress } from '@ai00-x/design-system/web';

<Progress value={72} />`,
      },
      {
        id: 'skeleton',
        title: '骨架屏 Skeleton',
        en: 'Skeleton',
        desc: '加载占位（墨阶底慢脉冲）；尺寸由消费方 style/className 给。',
        code: `import { Skeleton } from '@ai00-x/design-system/web';

<Skeleton style={{ height: 14, width: '60%' }} />`,
      },
    ],
  },
  {
    id: 'feedback',
    title: '反馈',
    components: [
      {
        id: 'alert',
        title: '警告提示 Alert',
        en: 'Alert',
        desc: '静态语义条（role=alert，error 为 assertive 播报）。语义色只表状态。',
        api: [
          { param: 'type', desc: '语义类型', type: "'success' | 'error' | 'warning' | 'info'", default: "'info'" },
          { param: 'message', desc: '正文（必填）', type: 'ReactNode', required: true },
          { param: 'title / description', desc: '标题/补充说明', type: 'ReactNode / string' },
          { param: 'closable / onClose', desc: '可关闭', type: 'boolean / () => void' },
        ],
        code: `import { Alert } from '@ai00-x/design-system/web';

<Alert type="success" message="模型加载完成 · 2.4s" closable />`,
      },
      {
        id: 'toast',
        title: '轻提示 Toast',
        en: 'Toast',
        desc: '命令式全局通知（右上角栈）。根挂一次 <ToastProvider />，任意处调用 toast()。',
        usage: ['轻反馈（保存成功/复制完成）用 toast；重要确认走 ConfirmDialog'],
        api: [
          { param: 'toast(msg, opts)', desc: '基础调用', type: "opts: {variant?, description?, duration?=4000, action?}" },
          { param: 'toastSuccess 等', desc: '语义快捷方法', type: '(msg, opts?) => void' },
          { param: 'action', desc: '行动按钮', type: '{label, onClick}' },
        ],
        code: `import { ToastProvider, toastSuccess } from '@ai00-x/design-system/web';

// 根组件挂一次 <ToastProvider />
toastSuccess('已保存', { description: '同步至云端' });`,
      },
      {
        id: 'modal',
        title: '对话框 Modal',
        en: 'Modal',
        desc: 'Radix Dialog 基件：焦点陷阱/焦点回归/aria-modal/Escape/滚动锁内建；拖拽与八向缩放为自绘增强。',
        usage: [
          '中等复杂度任务（表单/确认），重内容考虑 Drawer',
          'closeOnOverlayClick=false 防误触丢失输入',
        ],
        api: [
          { param: 'isOpen / onClose', desc: '受控开关', type: 'boolean / () => void', required: true },
          { param: 'title / titleExtra', desc: '标题与右侧附加', type: 'string / ReactNode' },
          { param: 'size', desc: '宽度档', type: "'small' | 'medium' | 'large' | 'xlarge'", default: "'medium'" },
          { param: 'closeOnOverlayClick', desc: '点遮罩关闭', type: 'boolean', default: 'true' },
          { param: 'draggable / resizable', desc: '拖拽/缩放', type: 'boolean', default: 'false' },
          { param: 'placement', desc: '弹出位置', type: "'center' | 'bottom-left' | 'bottom-right'", default: "'center'" },
        ],
        code: `import { Modal, Button } from '@ai00-x/design-system/web';

<Modal isOpen={open} onClose={() => setOpen(false)} title="命名工作区">
  <p>内容…</p>
</Modal>`,
      },
      {
        id: 'confirm-dialog',
        title: '确认框 ConfirmDialog',
        en: 'ConfirmDialog',
        desc: '命令式确认（Promise<boolean>）；根挂一次 <ConfirmDialogRenderer />。',
        api: [
          { param: 'confirmDialog(opts)', desc: '主调用（见下）', type: "opts: {title, message, type?='warning', confirmDanger?, preview?…}" },
          { param: 'confirmWarning / confirmDanger / confirmInfo', desc: '语义快捷', type: '(title, message, opts?) => Promise<boolean>' },
        ],
        code: `import { confirmDialog, ConfirmDialogRenderer } from '@ai00-x/design-system/web';

// 根挂 <ConfirmDialogRenderer />
if (await confirmDialog({ title: '删除？', message: '不可撤销', confirmDanger: true })) del();`,
      },
      {
        id: 'input-dialog',
        title: '输入对话框 InputDialog',
        en: 'InputDialog',
        desc: '替代原生 prompt() 的单字段对话框：自动聚焦全选、Enter 提交、校验失败不关闭。',
        api: [
          { param: 'isOpen / onClose', desc: '受控', type: 'boolean / () => void' },
          { param: 'onConfirm', desc: '确认回调（值）', type: '(value: string) => void', required: true },
          { param: 'validator', desc: '校验（返回错误文案或 null）', type: '(v) => string | null' },
          { param: 'inputType', desc: '输入类型', type: "'text' | 'password' | 'email' | 'number'", default: "'text'" },
        ],
        code: `import { InputDialog } from '@ai00-x/design-system/web';

<InputDialog isOpen={open} onClose={() => setOpen(false)}
  onConfirm={(v) => create(v)} title="新分支" placeholder="feature/x" />`,
      },
      {
        id: 'alert-dialog',
        title: '确认原语 AlertDialog',
        en: 'AlertDialog',
        desc: '组合式确认浮层原语（Radix）；命令式场景用 ConfirmDialog。',
        api: [
          { param: '复合', desc: 'Trigger/Content/Title/Description/Cancel/Action', type: '复合组件' },
          { param: 'Action variant', desc: "'primary' | 'destructive'", type: 'string', default: "'primary'" },
          { param: 'AlertDialogSimple', desc: '快捷组合（title/description/cancelText/actionText/onAction）', type: '复合 props' },
        ],
        code: `import { AlertDialog, AlertDialogTrigger, AlertDialogSimple } from '@ai00-x/design-system/web';

<AlertDialog>
  <AlertDialogTrigger asChild><Button>删除</Button></AlertDialogTrigger>
  <AlertDialogSimple title="删除工作区？" variant="destructive" actionText="删除" />
</AlertDialog>`,
      },
      {
        id: 'loading',
        title: '加载指示 Loading',
        en: 'CubeLoading / DotMatrixLoader',
        desc: 'CubeLoading：灵印圆脸动画（启动/推理场景）；DotMatrixLoader：轻量点阵等待。BrandMark animated 亦可作灵韵态。',
        api: [
          { param: 'CubeLoading size / text', desc: '尺寸与附文', type: "'small' | 'medium' | 'large' / string" },
          { param: 'DotMatrixLoader size', desc: '尺寸', type: "'small' | 'medium'", default: "'medium'" },
        ],
        code: `import { CubeLoading, DotMatrixLoader } from '@ai00-x/design-system/web';

<CubeLoading size="medium" text="推理中…" />
<DotMatrixLoader />`,
      },
    ],
  },
  {
    id: 'navigation',
    title: '导航与浮层',
    components: [
      {
        id: 'tabs',
        title: '选项卡 Tabs',
        en: 'Tabs',
        desc: 'WAI-ARIA 完整模式：tablist/tab/tabpanel + roving tabindex + ←→HomeEnd 键盘。⚠️ 风格属性名为 type（非 variant）。',
        usage: ['line 指示条带笔触动效（白名单场景）；card/pill 为容器变体'],
        api: [
          { param: 'type', desc: '风格（⚠️ 属性名 type）', type: "'line' | 'card' | 'pill'", default: "'line'" },
          { param: 'activeKey / onChange', desc: '受控当前页', type: 'string / (key) => void' },
          { param: 'TabPane', desc: '页签：tabKey/label/icon/disabled/closable', type: '复合 props' },
        ],
        code: `import { Tabs, TabPane } from '@ai00-x/design-system/web';

<Tabs activeKey={k} onChange={setK}>
  <TabPane tabKey="a" label="概述"><p>…</p></TabPane>
</Tabs>`,
      },
      {
        id: 'tooltip',
        title: '文字提示 Tooltip',
        en: 'Tooltip',
        desc: '单句悬浮提示（web 系 BEM 版）：四向自动翻转、followCursor 光标跟随、键盘 focus-visible 可见。',
        usage: ['补充说明用 Tooltip；富内容面板用 Popover', 'children 须为单个 React 元素（cloneElement 注入）'],
        api: [
          { param: 'content', desc: '提示内容', type: 'ReactNode', required: true },
          { param: 'placement', desc: '方向（自动翻转）', type: "'top' | 'bottom' | 'left' | 'right'", default: "'top'" },
          { param: 'followCursor', desc: '跟随光标（工具栏推荐）', type: 'boolean', default: 'false' },
          { param: 'interactive', desc: '可悬停交互', type: 'boolean', default: 'false' },
        ],
        code: `import { Tooltip } from '@ai00-x/design-system/web';

<Tooltip content="顶部提示" placement="top">
  <Button variant="ghost">悬停</Button>
</Tooltip>`,
      },
      {
        id: 'dropdown-menu',
        title: '下拉菜单 DropdownMenu',
        en: 'DropdownMenu',
        desc: '菜单类浮层（项列表/操作组）。**业务侧禁止手写下拉菜单**——一律用它。',
        api: [
          { param: '复合', desc: 'Trigger/Content/Item/Separator/Label/Sub(Trigger/Content)', type: '复合组件' },
          { param: 'Item props', desc: 'destructive? / checkbox? / radio? / onSelect?', type: '复合 props' },
        ],
        code: `import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@ai00-x/design-system/web';

<DropdownMenu>
  <DropdownMenuTrigger asChild><Button>操作</Button></DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuItem>重命名</DropdownMenuItem>
    <DropdownMenuItem destructive>删除</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>`,
      },
      {
        id: 'popover',
        title: '气泡卡片 Popover',
        en: 'Popover',
        desc: '锚定富内容浮层（表单/选择器/设置面板）；virtualRef 支持纯 rect 锚定。',
        usage: ['模型选择器等受控场景配 open/onOpenChange'],
        api: [
          { param: '复合', desc: 'Trigger/Anchor(virtualRef?)/Content(side?/align?/sideOffset?)/Close', type: '复合组件' },
          { param: 'Content side/align', desc: '弹出方向与对齐', type: "'top'|'right'|'bottom'|'left' / 'start'|'center'|'end'" },
        ],
        code: `import { Popover, PopoverTrigger, PopoverContent } from '@ai00-x/design-system/web';

<Popover>
  <PopoverTrigger asChild><Button>设置</Button></PopoverTrigger>
  <PopoverContent align="start">…面板…</PopoverContent>
</Popover>`,
      },
      {
        id: 'drawer',
        title: '抽屉 Drawer',
        en: 'Drawer',
        desc: '侧滑面板（详情/设置）；滑入 0.3s，遮罩 + L4 玻璃。',
        api: [
          { param: 'DrawerContent side', desc: '滑出方向', type: "'right' | 'left' | 'top' | 'bottom'", default: "'right'" },
          { param: 'DrawerPanel', desc: '快捷组合（title/description/side + children）', type: '复合 props' },
        ],
        code: `import { Drawer, DrawerTrigger, DrawerPanel } from '@ai00-x/design-system/web';

<Drawer>
  <DrawerTrigger asChild><Button>详情</Button></DrawerTrigger>
  <DrawerPanel title="组件目录">…</DrawerPanel>
</Drawer>`,
      },
      {
        id: 'context-menu',
        title: '右键菜单 ContextMenu',
        en: 'ContextMenu',
        desc: '右键上下文菜单（Radix 原语，.ds-menu）。',
        code: `import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@ai00-x/design-system/react';

<ContextMenu>
  <ContextMenuTrigger asChild><div>右键区域</div></ContextMenuTrigger>
  <ContextMenuContent><ContextMenuItem>操作</ContextMenuItem></ContextMenuContent>
</ContextMenu>`,
      },
    ],
  },
  {
    id: 'layout',
    title: '布局与其它',
    components: [
      {
        id: 'separator',
        title: '分隔线 Separator',
        en: 'Separator',
        desc: '结构分隔（横向/纵向），decorative 默认 true。',
        api: [
          { param: 'orientation', desc: '方向', type: "'horizontal' | 'vertical'", default: "'horizontal'" },
        ],
        code: `import { Separator } from '@ai00-x/design-system/web';

<Separator orientation="vertical" />`,
      },
      {
        id: 'scroll-area',
        title: '滚动区 ScrollArea',
        en: 'ScrollArea',
        desc: '统一滚动条样式的滚动容器。',
        code: `import { ScrollArea } from '@ai00-x/design-system/web';

<ScrollArea style={{ height: 200 }}>…</ScrollArea>`,
      },
      {
        id: 'config-page',
        title: '配置页三件套 ConfigPage',
        en: 'ConfigPage',
        desc: '设置页标准件：Loading（载入）/Message（结果反馈）/RefreshButton（刷新）。',
        code: `import { ConfigPageLoading, ConfigPageMessage, ConfigPageRefreshButton } from '@ai00-x/design-system/web';

<ConfigPageRefreshButton onClick={reload} loading={loading} />
<ConfigPageLoading text="载入配置…" />
<ConfigPageMessage message={{ type: 'success', text: '已保存' }} />`,
      },
      {
        id: 'window-controls',
        title: '窗口控件 WindowControls',
        en: 'WindowControls',
        desc: '自定义标题栏的最小化/最大化/关闭三键组（桌面端）。',
        api: [
          { param: 'onMinimize / onMaximize / onClose', desc: '三键回调', type: '() => void' },
          { param: 'show* / disabled / isMaximized', desc: '显隐与状态', type: 'boolean' },
        ],
        code: `import { WindowControls } from '@ai00-x/design-system/web';

<WindowControls onMinimize={min} onMaximize={max} onClose={close} />`,
      },
    ],
  },
];

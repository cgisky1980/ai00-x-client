/**
 * DesignShowcase —— @ai00-x/design-system · 新东方极简 全组件总览页
 *
 * 单页长卷：门面（灵印+衬线标题+朱砂唯一CTA）→ 令牌（墨阶/黛青/语义/排版/阴影）
 * → 23 个 web 组件分区演示。样式全部走 token（design-showcase.scss）。
 */

import React, { useState } from 'react';
import { BrandMark, Button as DsButton } from '@ai00-x/design-system/react';
import {
  Card,
  Badge,
  Alert,
  Button,
  IconButton,
  Input,
  Textarea,
  Search,
  Select,
  Checkbox,
  Switch,
  NumberInput,
  Tabs,
  TabPane,
  Tag,
  Tooltip,
  Modal,
  InputDialog,
  CubeLoading,
  DotMatrixLoader,
  StarRating,
  WindowControls,
  ConfigPageLoading,
  ConfigPageMessage,
  ConfigPageRefreshButton,
  ConfirmDialogRenderer,
  confirmDialog,
} from '@/component-library';
import type { SelectOption } from '@/component-library';
import './design-showcase.scss';

/* ---------- 内联图标（演示用） ---------- */
const IconSearch = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2" /><path d="M11 11L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
const IconStar = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L10 6L14 6.5L11 9.5L12 14L8 11.5L4 14L5 9.5L2 6.5L6 6L8 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
);
const IconGear = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="2" /><path d="M8 1V3M8 13V15M15 8H13M3 8H1M13.5 2.5L12 4M4 12L2.5 13.5M13.5 13.5L12 12M4 4L2.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
const IconTrash = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4H13M5 4V3C5 2.5 5.5 2 6 2H10C10.5 2 11 2.5 11 3V4M6 7V12M10 7V12M4 4L5 14H11L12 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/* ---------- 小节骨架 ---------- */

const Section: React.FC<{ id: string; no: string; title: string; desc?: string; children: React.ReactNode }> = ({ id, no, title, desc, children }) => (
  <section className="ds-show-section" id={id}>
    <header className="ds-show-section__head">
      <span className="ds-show-section__no">{no}</span>
      <div>
        <h2 className="ds-show-section__title">{title}</h2>
        {desc && <p className="ds-show-section__desc">{desc}</p>}
      </div>
    </header>
    <div className="ds-show-section__body">{children}</div>
  </section>
);

const Row: React.FC<{ label?: string; children: React.ReactNode; className?: string }> = ({ label, children, className = '' }) => (
  <div className={`ds-show-row ${className}`}>
    {label && <span className="ds-show-row__label">{label}</span>}
    <div className="ds-show-row__items">{children}</div>
  </div>
);

const Swatch: React.FC<{ cssVar: string; name: string; note?: string }> = ({ cssVar, name, note }) => (
  <div className="ds-show-swatch">
    <div className="ds-show-swatch__chip" style={{ background: `var(${cssVar})` }} />
    <div className="ds-show-swatch__meta">
      <span className="ds-show-swatch__name">{name}</span>
      <span className="ds-show-swatch__var">{cssVar}</span>
      {note && <span className="ds-show-swatch__note">{note}</span>}
    </div>
  </div>
);

/* ---------- 各分区 ---------- */

const HeroSection: React.FC = () => (
  <section className="ds-show-hero">
    <div className="ds-show-hero__mark">
      <BrandMark variant="seal" size={72} animated />
    </div>
    <p className="ds-show-hero__kicker">AI00-X DESIGN SYSTEM · 新东方极简</p>
    <h1 className="ds-show-hero__title ds-display">墨为骨 · 青为神<br />朱为印 · 白为息</h1>
    <p className="ds-show-hero__sub">
      350+ 设计令牌 · 23 个组件 · 明暗双主题。<span className="ds-data">0x1.92p+6</span> 处调用点统一于同一套语法。
    </p>
    <div className="ds-show-hero__actions">
      {/* 本页唯一朱砂 */}
      <DsButton variant="seal">开始创作</DsButton>
      <span className="ds-show-hero__hint">朱砂一屏一处 —— 仅用于门面 CTA 或灵印</span>
    </div>
  </section>
);

const TokenColorSection: React.FC = () => (
  <>
    <Row label="墨阶 · 五级表面">
      <Swatch cssVar="--color-bg-base" name="Base" note="页面底" />
      <Swatch cssVar="--color-bg-sunken" name="Sunken" note="沉底/输入" />
      <Swatch cssVar="--color-bg-card" name="Card" note="卡片" />
      <Swatch cssVar="--color-bg-elevated" name="Elevated" note="浮层" />
      <Swatch cssVar="--color-bg-overlay" name="Overlay" note="遮罩" />
    </Row>
    <Row label="黛青 · 唯一交互色">
      {[50, 100, 200, 300, 400, 500, 600, 700, 800].map((n) => (
        <Swatch key={n} cssVar={`--color-accent-${n}`} name={`${n}`} note={n === 500 ? '基准' : undefined} />
      ))}
      <Swatch cssVar="--color-accent-foreground" name="Foreground" note="青底上的纸白字" />
    </Row>
    <Row label="语义 · 只表状态">
      <Swatch cssVar="--color-success" name="Success" />
      <Swatch cssVar="--color-warning" name="Warning" />
      <Swatch cssVar="--color-error" name="Error" />
      <Swatch cssVar="--color-info" name="Info" />
      <Swatch cssVar="--color-brand-seal" name="Brand Seal" note="朱砂 · 一屏一处" />
    </Row>
  </>
);

const TokenTypeSection: React.FC = () => (
  <div className="ds-show-type">
    <div>
      <div className="ds-show-type__label">Display · 衬线（门面时刻）</div>
      <div className="ds-show-type__display ds-display">灵机一动</div>
    </div>
    <div>
      <div className="ds-show-type__label">Body · 14px Sans</div>
      <div className="ds-show-type__body">正文永远 14px，层次交给字重与留白，而不是字号竞赛。</div>
    </div>
    <div>
      <div className="ds-show-type__label">Data · Mono + tabular-nums</div>
      <div className="ds-show-type__data ds-data">128,406 · 98.7% · 00:04:31</div>
    </div>
  </div>
);

const TokenShadowSection: React.FC = () => (
  <div className="ds-show-shadows">
    {(['xs', 'sm', 'base', 'lg', 'xl', '2xl'] as const).map((tier) => (
      <div key={tier} className="ds-show-shadows__cell">
        <div className="ds-show-shadows__card" style={{ boxShadow: `var(--shadow-${tier})` }} />
        <span className="ds-show-shadows__name">--shadow-{tier}</span>
      </div>
    ))}
    <div className="ds-show-shadows__cell">
      <div className="ds-show-shadows__card ds-show-shadows__card--rounded" />
      <span className="ds-show-shadows__name">--size-radius-*</span>
    </div>
  </div>
);

const ButtonSection: React.FC = () => (
  <>
    <Row label="Button">
      <Button variant="primary">主按钮 · 黛青</Button>
      <Button variant="default">次级</Button>
      <Button variant="ghost">幽灵</Button>
      <Button variant="ghost" disabled>禁用</Button>
      <DsButton variant="destructive">危险</DsButton>
    </Row>
    <Row label="尺寸">
      <Button size="small">Small</Button>
      <Button size="medium">Medium</Button>
      <Button size="large">Large</Button>
    </Row>
    <Row label="IconButton">
      <IconButton variant="default" aria-label="search"><IconSearch /></IconButton>
      <IconButton variant="primary" aria-label="star"><IconStar /></IconButton>
      <IconButton variant="ghost" aria-label="settings"><IconGear /></IconButton>
      <IconButton variant="danger" aria-label="delete"><IconTrash /></IconButton>
      <IconButton variant="primary" aria-label="loading" isLoading><IconStar /></IconButton>
    </Row>
  </>
);

const FormSection: React.FC = () => {
  const [selectVal, setSelectVal] = useState<string | number>('');
  const [multiVal, setMultiVal] = useState<(string | number)[]>(['react']);
  const [num, setNum] = useState(42);
  const [check, setCheck] = useState(true);
  const [sw, setSw] = useState(false);
  const [star, setStar] = useState(4);
  const [searchLoading, setSearchLoading] = useState(false);

  const options: SelectOption[] = [
    { label: '黛青 · Deep Cyan', value: 'accent' },
    { label: '朱砂 · Cinnabar', value: 'seal' },
    { label: '宣纸 · Xuan Paper', value: 'paper', disabled: true },
    { label: '松烟 · Ink', value: 'ink' },
  ];

  return (
    <div className="ds-show-form">
      <div className="ds-show-form__col">
        <Input label="文本" placeholder="沉底表面 + 黛青 focus…" />
        <Input label="带前缀" placeholder="example@ai00-x.com" prefix="@" />
        <Input label="错误态" placeholder="错误演示" error errorMessage="该字段不可为空" />
        <Textarea label="多行" placeholder="自动增高…" autoResize />
      </div>
      <div className="ds-show-form__col">
        <Select
          label="单选 · 可搜索"
          searchable
          options={options}
          value={selectVal}
          onChange={(v) => setSelectVal(v as string)}
          placeholder="选择一种意象…"
          clearable
        />
        <Select
          label="多选"
          multiple
          showSelectAll
          options={options}
          value={multiVal}
          onChange={(v) => setMultiVal(v as (string | number)[])}
          placeholder="可多选"
        />
        <NumberInput label="数值" value={num} onChange={setNum} min={0} max={100} unit="%" />
      </div>
      <div className="ds-show-form__col">
        <Search placeholder="搜索…" showSearchButton loading={searchLoading}
          onSearch={() => { setSearchLoading(true); setTimeout(() => setSearchLoading(false), 1200); }} />
        <div className="ds-show-form__toggles">
          <Checkbox label="记住偏好" checked={check} onChange={(e) => setCheck(e.target.checked)} />
          <Checkbox label="半选" indeterminate />
          <Checkbox label="禁用" disabled />
        </div>
        <div className="ds-show-form__toggles">
          <Switch label="智能路由" checked={sw} onChange={(e) => setSw(e.target.checked)} />
          <Switch label="带文字" checkedText="开" uncheckedText="关" />
          <Switch label="禁用" disabled />
        </div>
        <StarRating value={star} onChange={setStar} label="评分" />
      </div>
    </div>
  );
};

const NavSection: React.FC = () => (
  <>
    <Row label="Tabs · line / card / pill">
      <div className="ds-show-tabs">
        <Tabs type="line" defaultActiveKey="a">
          <TabPane tabKey="a" label="概述"><div className="ds-show-tabpane">笔断意连 —— 指示条带笔触动效</div></TabPane>
          <TabPane tabKey="b" label="令牌"><div className="ds-show-tabpane">350+ token 直出 CSS 变量</div></TabPane>
          <TabPane tabKey="c" label="组件"><div className="ds-show-tabpane">23 个 web 组件</div></TabPane>
        </Tabs>
      </div>
    </Row>
    <Row label="Tag">
      <Tag color="blue">blue</Tag>
      <Tag color="green">green</Tag>
      <Tag color="red">red</Tag>
      <Tag color="yellow">yellow</Tag>
      <Tag color="gray">gray</Tag>
      <Tag>default</Tag>
      <Tag color="blue" closable onClose={() => {}}>closable</Tag>
    </Row>
    <Row label="Badge">
      <Badge variant="accent">黛青</Badge>
      <Badge variant="success">成功</Badge>
      <Badge variant="warning">警告</Badge>
      <Badge variant="error">错误</Badge>
      <Badge>中性</Badge>
    </Row>
  </>
);

const FeedbackSection: React.FC = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);

  return (
    <>
      <Row label="Alert">
        <div className="ds-show-alerts">
          <Alert type="success" message="模型加载完成 · 2.4s" closable />
          <Alert type="info" message="黛青是唯一交互色" />
          <Alert type="warning" message="朱砂一屏最多一处" />
          <Alert type="error" message="连接失败 · ECONNREFUSED" />
        </div>
      </Row>
      <Row label="Loading">
        <div className="ds-show-loaders">
          <CubeLoading size="small" />
          <CubeLoading size="medium" text="推理中…" />
          <DotMatrixLoader />
          <DotMatrixLoader size="small" />
        </div>
      </Row>
      <Row label="灵韵态 · BrandMark animated">
        <div className="ds-show-loaders">
          <BrandMark variant="ink" size={40} animated />
          <BrandMark variant="ink" size={24} animated />
          <span className="ds-show-hero__hint">圆脸呼吸 + 眨眼，与 CubeLoading 同源——仅用于 loading / 启动场景</span>
        </div>
      </Row>
      <Row label="Dialogs">
        <Button onClick={() => setModalOpen(true)}>Modal</Button>
        <Button onClick={() => setInputOpen(true)}>InputDialog</Button>
        <Button onClick={() => void confirmDialog({ title: '删除工作区？', message: '此操作不可撤销。', type: 'warning' })}>
          ConfirmDialog
        </Button>
      </Row>
      <Row label="ConfigPage · 三件套">
        <div className="ds-show-config">
          <ConfigPageRefreshButton tooltip="刷新" onClick={() => {}} loading={false} />
          <ConfigPageLoading text="正在载入配置…" />
        </div>
        <div className="ds-show-config ds-show-config--msg">
          <ConfigPageMessage message={{ type: 'info', text: '配置已保存' }} />
        </div>
      </Row>
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="对话框 · 玻璃浮层">
        <div className="ds-show-modal-body">
          <p>backdrop-blur 只属于浮层；卡片永远是实体墨面。</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>确定</Button>
          </div>
        </div>
      </Modal>
      <InputDialog
        isOpen={inputOpen}
        onClose={() => setInputOpen(false)}
        onConfirm={() => setInputOpen(false)}
        title="命名工作区"
        description="使用小写字母与连字符"
        placeholder="my-workspace"
      />
      <ConfirmDialogRenderer />
    </>
  );
};

const OverlaySection: React.FC = () => (
  <Row label="Tooltip · 四向" className="ds-show-row--pad">
    <Tooltip content="上方 · 黛青" placement="top"><Button variant="ghost">Top</Button></Tooltip>
    <Tooltip content="下方" placement="bottom"><Button variant="ghost">Bottom</Button></Tooltip>
    <Tooltip content="左侧" placement="left"><Button variant="ghost">Left</Button></Tooltip>
    <Tooltip content="右侧" placement="right"><Button variant="ghost">Right</Button></Tooltip>
  </Row>
);

const CardSection: React.FC = () => (
  <div className="ds-show-cards">
    <Card variant="default">
      <div className="ds-show-card__title">Default · 墨面卡片</div>
      <p>层次靠墨阶，不靠边框堆砌。</p>
    </Card>
    <Card variant="elevated">
      <div className="ds-show-card__title">Elevated · 浮起</div>
      <p>更亮一级的表面，用于悬浮态。</p>
    </Card>
    <Card variant="subtle">
      <div className="ds-show-card__title">Subtle · 沉底</div>
      <p>比底色更深一档的安静区域。</p>
    </Card>
    <Card variant="accent">
      <div className="ds-show-card__title">Accent · 青染</div>
      <p>唯一交互色的浅染底，用于选中。</p>
    </Card>
    <Card interactive>
      <div className="ds-show-card__title">Interactive</div>
      <p>悬停试一试 —— 影随之上浮。</p>
    </Card>
    <div className="ds-show-card--win">
      <div className="ds-show-card__title">WindowControls</div>
      <div className="ds-show-card__winbar">
        <WindowControls onMinimize={() => {}} onMaximize={() => {}} onClose={() => {}} />
      </div>
    </div>
  </div>
);

/* ---------- 页面 ---------- */

export const DesignShowcase: React.FC = () => (
  <div className="ds-show">
    <HeroSection />

    <Section id="ds-color" no="01" title="令牌 · 色彩" desc="墨阶定层次，黛青司交互，语义色只表状态，朱砂只落一处。">
      <TokenColorSection />
    </Section>

    <Section id="ds-type" no="02" title="令牌 · 排版" desc="门面用衬线，机器输出用等宽 tabular，正文 14px。">
      <TokenTypeSection />
    </Section>

    <Section id="ds-shadow" no="03" title="令牌 · 阴影与圆角" desc="影子是墨的呼吸，六档即止。">
      <TokenShadowSection />
    </Section>

    <Section id="ds-button" no="04" title="按钮" desc="黛青主按钮 · 对比 5.69:1；高频操作 0.1–0.15s 微动效。">
      <ButtonSection />
    </Section>

    <Section id="ds-form" no="05" title="表单" desc="沉底输入 + 黛青 focus ring；错误只用语义红。">
      <FormSection />
    </Section>

    <Section id="ds-nav" no="06" title="导航与标识" desc="Tab 指示条是笔触动效白名单场景之一。">
      <NavSection />
    </Section>

    <Section id="ds-feedback" no="07" title="反馈与浮层" desc="Alert 表状态；对话框用玻璃，卡片用墨面。">
      <FeedbackSection />
    </Section>

    <Section id="ds-overlay" no="08" title="浮层锚点" desc="Tooltip 跟随黛青。">
      <OverlaySection />
    </Section>

    <Section id="ds-card" no="09" title="卡片与其他" desc="四种表面 + 交互态 + 桌面窗口控件。">
      <CardSection />
    </Section>

    <footer className="ds-show-footer">
      <BrandMark variant="line" />
      <span>Ai00-X Design System · 规范 v0.6 · 明暗双主题下所有 token 自动切换</span>
    </footer>
  </div>
);

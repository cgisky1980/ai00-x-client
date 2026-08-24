/**
 * Ai00-UI —— @ai00-x/design-system 組件套件演示站
 * 設計哲學：墨為骨，青為神，朱為印，白為息（新東方極簡）
 */
import { useState } from "react";
import {
  // web 系（API 相容系）
  Button, IconButton, Badge, Tag, Alert,
  Input, Textarea, Search, Select, NumberInput,
  Checkbox, Switch, Tabs, TabPane, StarRating,
  Modal, ConfirmDialog, InputDialog, Tooltip,
  DotMatrixLoader,
  // ds 系（直出 web barrel）
  ToastProvider, toast, toastSuccess, toastError,
  Progress, Skeleton, Separator, Avatar, Empty,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  Popover, PopoverTrigger, PopoverContent,
  Drawer, DrawerTrigger, DrawerPanel,
  AlertDialog, AlertDialogTrigger, AlertDialogSimple,
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
  Pagination, Tree,
} from "@ai00-x/design-system/web";
import { BrandMark } from "@ai00-x/design-system/react";
import {
  Moon, Sun, Home, Settings, ChevronDown, Rocket, Trash2, Copy, Play,
} from "lucide-react";

type Theme = "light" | "dark";

/* ---------- 小節容器 ---------- */
const Section = ({ id, title, note, children }: {
  id: string; title: string; note?: string; children: React.ReactNode;
}) => (
  <section className="uikit-section" id={id}>
    <header className="uikit-section__head">
      <h2>{title}</h2>
      {note && <p className="uikit-section__note">{note}</p>}
    </header>
    <div className="uikit-section__body">{children}</div>
  </section>
);

const Row = ({ label, children }: { label?: string; children: React.ReactNode }) => (
  <div className="uikit-row">
    {label && <span className="uikit-row__label">{label}</span>}
    <div className="uikit-row__content">{children}</div>
  </div>
);

/* ---------- App ---------- */
export default function App() {
  const [theme, setTheme] = useState<Theme>("light");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState("intro");
  const [check, setCheck] = useState(true);
  const [indeterminate, setIndeterminate] = useState(true);
  const [sw, setSw] = useState(false);
  const [num, setNum] = useState(42);
  const [sel, setSel] = useState<string | number>("ink");
  const [multi, setMulti] = useState<(string | number)[]>(["seal"]);
  const [page, setPage] = useState(3);
  const [treeNode, setTreeNode] = useState<string | null>("tokens");
  const [star, setStar] = useState(4);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
  };

  return (
    <>
      {/* Toast viewport：自閉合根部掛載（見 toast.tsx 用法註釋） */}
      <ToastProvider />
      <div className="uikit" data-theme={theme}>
        {/* ---------- Hero ---------- */}
        <header className="uikit-hero">
          <div className="uikit-hero__mark"><BrandMark animated size={56} /></div>
          <div className="uikit-hero__text">
            <p className="uikit-hero__eyebrow">Ai00-X Design System</p>
            <h1 className="uikit-hero__title">Ai00-UI</h1>
            <p className="uikit-hero__sub">
              墨為骨 · 青為神 · 朱為印 · 白為息 —— 新東方極簡組件套件
            </p>
          </div>
          <div className="uikit-hero__actions">
            <Tooltip content="返回 ai00-x.com" placement="bottom">
              <a className="uikit-home" href="https://ai00-x.com" aria-label="返回首页"><Home size={18} /></a>
            </Tooltip>
            <IconButton
              variant="ghost" shape="circle" size="large"
              tooltip={theme === "light" ? "切換松煙墨" : "切換宣紙"}
              onClick={toggleTheme}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </IconButton>
          </div>
        </header>

        <main className="uikit-main">
          {/* ---------- 色彩令牌 ---------- */}
          <Section id="color" title="色彩令牌" note="墨階五級表面 + 黛青唯一交互色 + 朱砂一屏一印；語義色只表狀態">
            <div className="uikit-swatches">
              {[
                ["--color-bg-primary", "bg-primary 基底"], ["--color-bg-secondary", "bg-secondary"],
                ["--color-bg-card", "bg-card 卡片"], ["--color-bg-elevated", "bg-elevated 浮層"],
                ["--color-bg-sunken", "bg-sunken 沉降"],
              ].map(([v, n]) => (
                <figure key={v} className="uikit-swatch">
                  <div className="uikit-swatch__chip" style={{ background: `var(${v})` }} />
                  <figcaption><span className="mono">{v}</span><small>{n}</small></figcaption>
                </figure>
              ))}
              <figure className="uikit-swatch">
                <div className="uikit-swatch__chip uikit-swatch__chip--accent" />
                <figcaption><span className="mono">--color-accent-500</span><small>黛青 · 唯一交互色</small></figcaption>
              </figure>
              <figure className="uikit-swatch">
                <div className="uikit-swatch__chip uikit-swatch__chip--seal" />
                <figcaption><span className="mono">--color-brand-seal</span><small>朱砂 · 一屏一印</small></figcaption>
              </figure>
            </div>
          </Section>

          {/* ---------- 排版 ---------- */}
          <Section id="type" title="排版" note="門面襯線 Display 棧（Ai00 X Serif 自託管子集）；機器輸出 mono + tabular-nums；正文 14px sans">
            <Row label="Display 襯線">
              <p className="uikit-type-display">靈墨青朱白 · 0·0·X</p>
            </Row>
            <Row label="字階">
              <div className="uikit-type-scale">
                {(["xxs", "2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"] as const).map((s) => (
                  <span key={s} style={{ fontSize: `var(--font-size-${s})` }}>靈{s}</span>
                ))}
              </div>
            </Row>
            <Row label="mono 機器輸出">
              <span className="mono-num">v0.13.2 · 363 tokens · 38 components · 2026-08-24 16:42:07</span>
            </Row>
          </Section>

          {/* ---------- 間距刻度 ---------- */}
          <Section id="space" title="間距刻度" note="Tailwind 式語義鍵（鍵×4px），18 檔覆蓋 1–64px；卡點已入 stylelint">
            <div className="uikit-gaps">
              {(["0-25", "0-5", "1", "1-5", "2", "2-5", "3", "3-5", "4", "4-5", "5", "6", "7", "8", "10", "12", "14", "16"] as const).map((g) => (
                <figure key={g} className="uikit-gap">
                  <div className="uikit-gap__bar" style={{ width: `var(--size-gap-${g})` }} />
                  <figcaption className="mono">{g}</figcaption>
                </figure>
              ))}
            </div>
          </Section>

          {/* ---------- 按鈕 ---------- */}
          <Section id="buttons" title="按鈕" note="主按鈕黛青實體；破壞操作朱砂語義；幽靈/描邊用於次級">
            <Row label="變體">
              <Button variant="primary"><Rocket size={14} /> 主按鈕</Button>
              <Button variant="secondary">次級</Button>
              <Button variant="dashed">虛線</Button>
              <Button variant="ghost">幽靈</Button>
              <Button variant="danger"><Trash2 size={14} /> 危險</Button>
              <Button variant="accent">強調</Button>
            </Row>
            <Row label="尺寸">
              <Button size="small">small</Button>
              <Button size="medium">medium</Button>
              <Button size="large">large</Button>
            </Row>
            <Row label="狀態">
              <Button isLoading>載入中</Button>
              <Button disabled>禁用</Button>
              <IconButton tooltip="複製" onClick={() => toastSuccess("已複製到剪貼簿")}><Copy size={16} /></IconButton>
              <IconButton variant="ghost" tooltip="播放" onClick={() => toast("開始渲染……")}><Play size={16} /></IconButton>
            </Row>
          </Section>

          {/* ---------- 表單 ---------- */}
          <Section id="forms" title="表單" note="原生 input 為底 + WAI-ARIA 補齊（E3b）：switch 語義 / spinbutton 值播報 / mixed 半選">
            <div className="uikit-form-grid">
              <Row label="Input"><Input placeholder="請輸入專案名稱" /></Row>
              <Row label="Search"><Search placeholder="搜尋元件…" /></Row>
              <Row label="Textarea"><Textarea placeholder="多行輸入…" rows={3} /></Row>
              <Row label="Select 單選">
                <Select
                  value={sel} onChange={(v) => setSel(v as string | number)} searchable clearable
                  options={[
                    { label: "宣紙 · 暖白", value: "xuanzhi", description: "hue 90 暖調紙面" },
                    { label: "松煙墨 · 冷青", value: "ink", description: "hue 240 高級深灰" },
                    { label: "黛青 · 交互", value: "accent", description: "唯一交互色" },
                    { label: "朱砂 · 靈印", value: "seal", description: "一屏最多一處" },
                  ]}
                />
              </Row>
              <Row label="Select 多選">
                <Select
                  multiple value={multi} onChange={(v) => setMulti(v as (string | number)[])}
                  showSelectAll placeholder="挑選令牌族"
                  options={[
                    { label: "色彩", value: "color" }, { label: "字型", value: "font" },
                    { label: "間距", value: "space" }, { label: "圓角", value: "radius" },
                    { label: "動效", value: "motion" }, { label: "朱砂印", value: "seal" },
                  ]}
                />
              </Row>
              <Row label="NumberInput">
                <NumberInput value={num} onChange={setNum} min={0} max={100} unit="%" draggable />
              </Row>
              <Row label="Checkbox">
                <Checkbox label="跟隨系統主題" checked={check} onChange={(e) => setCheck(e.target.checked)} />
                <Checkbox label="半選態 indeterminate" indeterminate={indeterminate}
                  onChange={(e) => setIndeterminate(e.target.checked)} />
              </Row>
              <Row label="Switch">
                <Switch label="墨階文字降噪" checked={sw} onChange={(e) => setSw(e.target.checked)} />
              </Row>
              <Row label="StarRating">
                <StarRating value={star} onChange={setStar} />
              </Row>
            </div>
          </Section>

          {/* ---------- 反饋 ---------- */}
          <Section id="feedback" title="反饋" note="語義色只表狀態；Toast 走右上通知層">
            <Row label="Alert">
              <Alert type="info" title="資訊" message="設計令牌已同步至三端。" />
              <Alert type="success" title="成功" message="字體子集載入完成（1.54MB VF）。" />
              <Alert type="warning" title="警告" message="朱砂一屏最多一處，請勿濫用。" />
              <Alert type="error" title="錯誤" message="檢測到硬編碼色值，已阻斷構建。" />
            </Row>
            <Row label="Badge / Tag">
              <Badge variant="accent">v0.13</Badge>
              <Badge variant="success">stable</Badge>
              <Badge>neutral</Badge>
              <Tag color="blue">token</Tag>
              <Tag color="yellow">a11y</Tag>
              <Tag>default</Tag>
            </Row>
            <Row label="Progress / Skeleton">
              <Progress value={72} />
              <div style={{ width: 220, display: "flex", flexDirection: "column", gap: 6 }}>
                <Skeleton style={{ height: "var(--size-gap-3-5)" }} />
                <Skeleton style={{ height: "var(--size-gap-3-5)", width: "70%" }} />
              </div>
            </Row>
            <Row label="Toast">
              <Button size="small" onClick={() => toastSuccess("儲存成功")}>success</Button>
              <Button size="small" onClick={() => toastError("連線失敗")}>error</Button>
            </Row>
            <Row label="Loader"><DotMatrixLoader /></Row>
            <Row label="Empty / Separator">
              <Empty description="暫無資料" />
              <Separator orientation="vertical" style={{ height: 56 }} />
              <Avatar name="Ai00-X" />
            </Row>
          </Section>

          {/* ---------- 資料展示 ---------- */}
          <Section id="data" title="資料展示" note="密度只出現在資料區；數字 mono + tabular-nums">
            <Row label="Table">
              <Table dense>
                <TableHeader>
                  <TableRow>
                    <TableHead>令牌</TableHead><TableHead>值</TableHead><TableHead>分類</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow><TableCell className="mono">--color-accent-500</TableCell><TableCell className="mono">oklch(0.55 0.09 235)</TableCell><TableCell>色彩</TableCell></TableRow>
                  <TableRow><TableCell className="mono">--size-gap-2-5</TableCell><TableCell className="mono">10px</TableCell><TableCell>間距</TableCell></TableRow>
                  <TableRow><TableCell className="mono">--font-size-base</TableCell><TableCell className="mono">14px</TableCell><TableCell>字階</TableCell></TableRow>
                  <TableRow><TableCell className="mono">--ease-brush</TableCell><TableCell className="mono">cubic-bezier(.65,0,.35,1)</TableCell><TableCell>動效</TableCell></TableRow>
                </TableBody>
              </Table>
            </Row>
            <Row label="Tree">
              <Tree
                nodes={[
                  { id: "root", label: "design-system", children: [
                    { id: "tokens", label: "tokens/", children: [
                      { id: "prim", label: "primitives.json" }, { id: "dark", label: "semantic.dark.json" },
                    ] },
                    { id: "comp", label: "components/", children: [{ id: "web", label: "web/ (23)" }, { id: "ds", label: "ds/ (20)" }] },
                  ] },
                ]}
                defaultExpandedIds={["root", "tokens"]}
                selectedId={treeNode ?? undefined}
                onSelect={(node) => setTreeNode(node.id)}
              />
            </Row>
            <Row label="Pagination">
              <Pagination page={page} total={13} onChange={setPage} />
            </Row>
          </Section>

          {/* ---------- 浮層 ---------- */}
          <Section id="overlays" title="浮層" note="玻璃僅限浮層；Modal 接 Radix Dialog（焦點陷阱/回歸，E3a）；下拉一律 DropdownMenu/Popover">
            <Row label="Tabs（roving tabindex）">
              <Tabs activeKey={tab} onChange={setTab}>
                <TabPane tabKey="intro" label="概覽"><p className="uikit-pane">38 組件雙出口：./react ds 系 + ./web API 相容系。</p></TabPane>
                <TabPane tabKey="tokens" label="令牌"><p className="uikit-pane">363 token，DTCG 三層直出 CSS 變數。</p></TabPane>
                <TabPane tabKey="a11y" label="無障礙"><p className="uikit-pane">E3a-c 全量 WAI-ARIA 基件化完成。</p></TabPane>
              </Tabs>
            </Row>
            <Row label="Modal / Dialogs">
              <Button size="small" onClick={() => setModalOpen(true)}>Modal</Button>
              <Button size="small" onClick={() => setConfirmOpen(true)}>ConfirmDialog</Button>
              <Button size="small" onClick={() => setInputOpen(true)}>InputDialog</Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="small" variant="secondary">AlertDialog</Button>
                </AlertDialogTrigger>
                <AlertDialogSimple
                  title="刪除令牌分支？"
                  description="此操作不可撤銷，該分支下所有未合併令牌將永久丟失。"
                  variant="destructive" actionText="刪除"
                />
              </AlertDialog>
            </Row>
            <Row label="DropdownMenu / Popover / Drawer / Tooltip">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="small" variant="dashed">匯出 <ChevronDown size={14} /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem>匯出為 JSON</DropdownMenuItem>
                  <DropdownMenuItem>匯出為 CSS</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>複製分享連結</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="small" variant="dashed"><Settings size={14} /> 偏好設定</Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="uikit-popover-body">
                  <p>黛青飽和度</p>
                  <input type="range" min={0} max={20} defaultValue={9} className="uikit-range" aria-label="黛青飽和度" />
                </PopoverContent>
              </Popover>
              <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
                <DrawerTrigger asChild>
                  <Button size="small" variant="ghost">Drawer</Button>
                </DrawerTrigger>
                <DrawerPanel title="組件目錄" description="規範 5.8 全量收錄">
                  <p className="uikit-pane">交互原語 11 + 資料展示 4 + web 系 23，共 38 組件雙出口。</p>
                </DrawerPanel>
              </Drawer>
              <Tooltip content="跟隨游標的 Tooltip（hover 試試）" placement="top" followCursor>
                <Button size="small" variant="ghost">Tooltip</Button>
              </Tooltip>
            </Row>
          </Section>
        </main>

        <footer className="uikit-footer">
          <Separator />
          <p>
            <BrandMark size={20} /> Ai00-UI · 基於
            <span className="mono"> @ai00-x/design-system v0.13</span>
            構建 —— <a href="https://ai00-x.com">ai00-x.com</a>
          </p>
        </footer>

        {/* 浮層實例 */}
        <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Modal · Radix Dialog">
          <p className="uikit-pane">
            焦點陷阱 / 焦點回歸 / aria-modal / Escape / 滾動鎖由 Radix 提供；
            拖拽與縮放保留自繪。試試按 Escape 或點擊遮罩關閉。
          </p>
        </Modal>
        <ConfirmDialog
          isOpen={confirmOpen} onClose={() => setConfirmOpen(false)}
          onConfirm={() => toastSuccess("已確認")}
          title="發佈設計系統 v0.14？" type="warning"
          message="將同步至 web-ui / underlay / loader / 官網 / Relay 五端。"
        />
        <InputDialog
          isOpen={inputOpen} onClose={() => setInputOpen(false)}
          onConfirm={(v) => toastSuccess(`已建立分支：${v}`)}
          title="新令牌分支" placeholder="feature/new-token"
        />
      </div>
    </>
  );
}

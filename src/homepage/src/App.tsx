/**
 * Ai00-X 官网首页 —— @ai00-x/design-system 重写（新东方极简 · 宣纸亮色）
 * 文案沿自 Vibe OS 版首页；内测申请走两阶段流程（ApplyModal）。
 */
import { useState } from "react";
import { BrandMark, Button as DsButton, Timeline, TimelineItem, Statistic } from "@ai00-x/design-system/react";
import ApplyModal from "./ApplyModal";
import { useReveal } from "./reveal";

const NAV = [
  { href: "#core", label: "氛围" },
  { href: "#local-first", label: "本地优先" },
  { href: "#a-day", label: "一天" },
  { href: "#agents", label: "智能体" },
  { href: "#social-proof", label: "口碑" },
];

const FEATURES = [
  {
    title: "音乐创作 · 分享",
    desc: "一句话，AI 把灵感变成旋律。逐词歌词、工作 BGM 电台；创作完成一键分享到广场，让更多人听见你的作品。",
    tags: ["AI 创作", "分享广场", "逐词歌词"],
  },
  {
    title: "自由桌面",
    desc: "说一句「我想要星空」，AI 为你生成专属壁纸。桌面还能替换成虚拟世界，灵动岛常驻，随时掌控全局。",
    tags: ["AI 壁纸", "桌面替换", "灵动岛"],
  },
  {
    title: "强大 Agent",
    desc: "taskwindow 承载，智能体像同事一样理解意图、自主执行。Plan / Debug / Review 多模式，从改代码到重构，一条龙办完。",
    tags: ["任务窗口", "多智能体", "多模式"],
  },
  {
    title: "AI 应用平台",
    desc: "一句话需求 → 可运行的 App。Skill / MCP 生态即插即用，可扩展性让它能源源不断孵化 AI 小应用。",
    tags: ["Mini App", "Skills", "MCP"],
  },
];

const LOCAL_POINTS = [
  "本地 RWKV 优先运行，离线可用、数据不出机器",
  "智能判断任务复杂度，简单任务本地一步跑完",
  "复杂任务才呼叫云端大模型，按需付费、即用即走",
];

const DAY = [
  { time: "08:30", title: "音乐电台", desc: "打开工作 BGM，AI 按今天的节奏挑好曲子，逐词歌词随音符流动。" },
  { time: "09:00", title: "专注工作", desc: "个人助理接单，代码 Agent 在任务窗口里自主读改跑验证，进度实时可见。" },
  { time: "15:00", title: "摸鱼时刻", desc: "给花园浇浇水，收一株果实，看看窗台上今天又留下了什么痕迹。" },
  { time: "18:00", title: "轻社交", desc: "邻居来串门，和访客聊两句；或背上行囊，去别家花园旅行一趟。" },
  { time: "23:00", title: "晚安", desc: "AI 道声晚安，明天见。它记住你的习惯，一天天变得更懂你。" },
];

const AGENTS = [
  { title: "个人助理", desc: "带长期记忆与稳定人格，记住你的偏好与审美，按需调度其它智能体，与你一起成长。" },
  { title: "代码智能体", desc: "Agentic / Plan / Debug / Review 四模式，从修 bug 到重构，给点需求就开工。" },
  { title: "协作智能体", desc: "原生处理 PDF、DOCX、XLSX、PPTX，需要更强的能力就上 Skill 市场现取现用。" },
  { title: "多端遥控", desc: "扫码配对，手机即成远程指挥中心；也支持 Telegram、飞书、微信 Bot，实时看进度。" },
];

const PROOF = [
  {
    quote: "写代码终于有声了。AI 按我的节奏生成工作歌单，代码 Agent 在任务窗口里帮我推进，这种感觉就是『氛围工作』。",
    name: "林",
    role: "独立开发者",
    tags: ["工作音乐", "Agent 协作"],
  },
  {
    quote: "摸鱼的时候给花园浇浇水，偶尔有 NPC 邻居来串门，轻社交刚刚好。桌面第一次有了『家』的感觉。",
    name: "陈",
    role: "产品经理",
    tags: ["花园社交", "轻娱乐"],
  },
];

export default function App() {
  const [applyOpen, setApplyOpen] = useState(false);
  const openApply = () => setApplyOpen(true);
  useReveal();

  return (
    <div className="hp">
      {/* ================= 顶栏 ================= */}
      <header className="hp-header">
        <a className="hp-brand" href="#" aria-label="Ai00-X 首页">
          <BrandMark variant="seal" size={30} />
          <span className="hp-brand__name">Ai00-X</span>
        </a>
        <nav className="hp-nav" aria-label="页面导航">
          {NAV.map((n) => (
            <a key={n.href} href={n.href}>{n.label}</a>
          ))}
        </nav>
        <div className="hp-header__actions">
          <DsButton variant="default" size="sm" onClick={openApply}>申请内测</DsButton>
        </div>
      </header>

      {/* ================= Hero（标题签名动效 brush-reveal：白名单场景1；其余 stagger 渐入） ================= */}
      <section className="hp-hero">
        <p className="hp-hero__kicker hp-reveal" style={{ ["--hp-rd" as string]: "0" }}>Vibe Work · Agentic OS · RWKV 本地大模型</p>
        <h1 className="hp-hero__title ds-brush-reveal">
          真正的<span className="hp-hero__accent">Vibe OS</span>
        </h1>
        <p className="hp-hero__sub hp-reveal" style={{ ["--hp-rd" as string]: "1" }}>
          Ai00-X 是住在你桌面里的 AI 伙伴，一台可自由定义的 Vibe OS。
          真正的好氛围——音乐、桌面、灵动工位，让人沉浸其中；
          高效的工具集——Agent、AI 应用、创作分享，让每件事都水到渠成。
        </p>
        <div className="hp-hero__actions hp-reveal" style={{ ["--hp-rd" as string]: "2" }}>
          <DsButton variant="seal" size="lg" onClick={openApply}>申请内测 →</DsButton>
          <DsButton variant="default" size="lg">下载桌面端</DsButton>
        </div>
        <p className="hp-hero__meta hp-reveal" style={{ ["--hp-rd" as string]: "3" }}>本地优先 · 隐私可控 · 跨平台 Windows / macOS / Linux</p>
      </section>

      {/* ================= 氛围 ================= */}
      <section className="hp-section" id="core">
        <p className="hp-section__index hp-reveal">/# core</p>
        <h2 className="hp-section__title hp-reveal">氛围，与生产力同行</h2>
        <p className="hp-section__desc hp-reveal">
          能干的 Agent、会创作的音乐、可扩展的 AI 应用平台——在 AI 定制的桌面里，把每件事都做得有温度。
        </p>
        <div className="hp-grid hp-grid--4 hp-reveal">
          {FEATURES.map((f) => (
            <article key={f.title} className="hp-card">
              <h3 className="hp-card__title">{f.title}</h3>
              <p className="hp-card__desc">{f.desc}</p>
              <div className="hp-card__tags">
                {f.tags.map((t) => <span key={t} className="hp-tag">{t}</span>)}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ================= 本地优先 ================= */}
      <section className="hp-section" id="local-first">
        <p className="hp-section__index hp-reveal">/# local-first</p>
        <h2 className="hp-section__title hp-reveal">本地优先，云端兜底</h2>
        <p className="hp-section__desc hp-reveal">
          小任务交给本地 RWKV，大任务才请求云端。省费用，也保隐私——谁也不愿为简单的事平白花钱。
        </p>
        <ul className="hp-points hp-reveal">
          {LOCAL_POINTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <div className="hp-flow hp-reveal" aria-hidden="true">
          <span className="hp-flow__node">任务进来</span>
          <span className="hp-flow__arrow">智能判断 · 成本与复杂度</span>
          <div className="hp-flow__split">
            <span className="hp-flow__node hp-flow__node--local">本地 RWKV<br /><em>快 · 免费 · 隐私</em></span>
            <span className="hp-flow__node">云端大模型<br /><em>强 · 按需 · 兜底</em></span>
          </div>
        </div>
      </section>

      {/* ================= 一天（Timeline 组件） ================= */}
      <section className="hp-section" id="a-day">
        <p className="hp-section__index hp-reveal">/# a day with ai00-x</p>
        <h2 className="hp-section__title hp-reveal">在 Ai00-X 的一天</h2>
        <p className="hp-section__desc hp-reveal">从清晨到深夜，AI 伙伴陪你度过每一个工作时刻。</p>
        <Timeline className="hp-reveal">
          {DAY.map((d, i) => (
            <TimelineItem
              key={d.time}
              time={d.time}
              title={d.title}
              description={d.desc}
              status={i < 2 ? "finish" : i === 2 ? "active" : "pending"}
            />
          ))}
        </Timeline>
      </section>

      {/* ================= 智能体 ================= */}
      <section className="hp-section" id="agents">
        <p className="hp-section__index hp-reveal">/# agents</p>
        <h2 className="hp-section__title hp-reveal">氛围之外，也能干活</h2>
        <p className="hp-section__desc hp-reveal">不只是会陪伴——真要做事时，它同样专业。</p>
        <div className="hp-grid hp-grid--4 hp-reveal">
          {AGENTS.map((a) => (
            <article key={a.title} className="hp-card">
              <h3 className="hp-card__title">{a.title}</h3>
              <p className="hp-card__desc">{a.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ================= 口碑 ================= */}
      <section className="hp-section" id="social-proof">
        <p className="hp-section__index hp-reveal">/# social proof</p>
        <h2 className="hp-section__title hp-reveal">正在被更多热爱生活的人使用</h2>
        <p className="hp-section__desc hp-reveal">从摸鱼到加班，Ai00-X 正在成为许多人的「数字搭子」与桌面氛围担当。</p>
        <div className="hp-grid hp-grid--2 hp-reveal">
          {PROOF.map((t) => (
            <figure key={t.name} className="hp-quote ds-hover-glow">
              <div className="hp-quote__stars" aria-label="五星好评">★★★★★</div>
              <blockquote>「{t.quote}」</blockquote>
              <figcaption>
                <span className="hp-quote__avatar">{t.name}</span>
                <span className="hp-quote__meta">
                  <strong>{t.name} · {t.role}</strong>
                  <em>{t.tags.join(" · ")}</em>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* ================= CTA ================= */}
      <section className="hp-cta">
        <h2 className="hp-cta__title hp-reveal">让工作，从今天开始有氛围</h2>
        <p className="hp-cta__sub hp-reveal">下载桌面端，点亮你的 AI 桌面。音乐、Agent、小应用，都在等你。</p>
        <div className="hp-cta__actions hp-reveal">
          <DsButton variant="seal" size="lg" onClick={openApply}>申请内测 →</DsButton>
          <DsButton variant="default" size="lg">下载桌面端</DsButton>
        </div>
      </section>

      {/* ================= 页脚 ================= */}
      <footer className="hp-footer">
        <div className="hp-footer__brand">
          <BrandMark variant="seal" size={22} />
          <span>Ai00-X · Agentic OS</span>
        </div>
        <div className="hp-footer__links">
          <a href="https://github.com/GCWing/Ai00-X" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="/ui/" title="Ai00-X 统一设计系统组件套件演示">Ai00-UI 组件库</a>
          <a href="#">隐私</a>
          <a href="#">服务条款</a>
        </div>
        <span className="hp-footer__beian">
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">苏ICP备2024073659号</a>
        </span>
      </footer>

      <ApplyModal open={applyOpen} onClose={() => setApplyOpen(false)} />
    </div>
  );
}

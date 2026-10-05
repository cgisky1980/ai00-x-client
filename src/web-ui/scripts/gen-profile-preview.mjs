/**
 * gen-profile-preview — 个人主页两套皮肤对比页生成器（开发工具）
 *
 * 为什么需要它：两套皮肤（中华极简 / 漫画风）的差异全在「描边语言 + 配色 +
 * 装饰」上，而真实主页要先登录、要服务端数据、要点进主题商店才看得到全貌。
 * 光靠真机验收的反馈环太长（build → zip → 重启客户端），改一版皮肤就要等一轮。
 *
 * 这个脚本把**真实引擎**的输出直接渲染成一个自包含 HTML：
 *   - 配色：palette.ts 的 derivePalette()（不是手抄的色值）
 *   - 色块封面：palette.ts 的 coverSwatches()（从 accent 色相旋出）
 *   - 皮肤 CSS：community.scss 的主页皮肤区块 **原样抽取**，不做改写
 *   - 数据：构造一份覆盖各种形态的样例（有无封面、长短标题、有无 bio…）
 * 所以看到的就是切主题后的真实排布——改了 SCSS 重新跑一次即可。
 *
 * 用法：
 *   pnpm --dir client run preview:profile
 *
 * 输出：client/dist/profile-preview/index.html（单文件，可直接双击打开）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 预览页必须内联 design-system token（间距/字号/字体栈），否则页面会被压扁
const { buildTokenCss } = await import('./preview-tokens.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_UI = resolve(HERE, '..');
const CLIENT = resolve(WEB_UI, '../..');
const COMMUNITY = resolve(WEB_UI, 'src/app/member-chat/community');

// ---- 真实引擎 ----
// 为什么不直接 import .ts：源码里的相对导入是 extensionless（'./palette'），
// 那是给 bundler 解析的；Node 的 ESM 不做扩展名补全，直接 import 会
// ERR_MODULE_NOT_FOUND。所以先用 vite 把需要的模块打成一个临时 ESM 再 import。
// 这样仍然是「跑真实源码」，不是抄一份逻辑。
const os = await import('node:os');
const bundleDir = resolve(os.tmpdir(), 'ai00-profile-preview-bundle');
const bundlePath = resolve(bundleDir, 'ai00-profile-preview-engine.mjs');
const { build } = await import('vite');

const ENGINE_ENTRY = ['themes.ts', 'fingerprintViews.ts', 'coverArt.ts']
  .map((f) => `export * from ${JSON.stringify(resolve(COMMUNITY, f))};`)
  .join('\n');
const engineEntryPath = resolve(os.tmpdir(), `ai00-profile-preview-entry-${process.pid}.ts`);
writeFileSync(engineEntryPath, ENGINE_ENTRY, 'utf8');

await build({
  logLevel: 'silent',
  configFile: false,
  build: {
    write: true,
    minify: false,
    lib: {
      entry: engineEntryPath,
      formats: ['es'],
      fileName: () => 'ai00-profile-preview-engine.mjs',
    },
    rollupOptions: { external: ['react', 'react/jsx-runtime'] },
    outDir: bundleDir,
    emptyOutDir: true,
  },
});

const engine = await import(pathToFileURL(bundlePath).href);
const {
  coverLetter,
  fpHeatColumns,
  fpClock,
  fpGenres,
  fpMilestones,
  fpSealSvg,
} = engine;

/**
 * 2 套官方主题 —— 与 Rust 迁移 035 的常量表、themes.test.ts、
 * sqlite.rs::test_migration_035_theme_styles 四处保持一致。
 */
/**
 * 两套皮肤 —— 这里没有任何颜色。
 *
 * 皮肤长什么样完全由 community.scss 的 [data-style] 块决定；本表只负责
 * 「有哪些皮肤、叫什么、卖多少钱」。
 *
 * 加一套新皮肤 = ① 在 community.scss 加一个 [data-style='xxx'] 块
 *              ② 在这里加一行元信息（可选）
 * 不用改 themes.ts、不用改测试常量表、payload 里也不再写颜色。
 */
const OFFICIAL = [
  {
    slug: 'xuanzhi',
    name: '宣纸',
    style: 'minimal',
    price: '免费',
    note: '中华极简 —— 1px 细描边、无投影、大留白、衬线大标题、墨阶 + 黛青',
  },
  {
    slug: 'manhua',
    name: '漫画',
    style: 'comic',
    price: '200',
    note: '漫画风 —— 3px 粗黑描边 + 右下硬投影 + 色块封面 + 倾斜图标砖 + 手绘撒花',
  },
];

/**
 * 只渲染某一套皮肤（评审 / 截图用）：
 *   node gen-profile-preview.mjs --only=comic
 * 不传则渲染全部。--only 传了未知的 style 会直接报错（不静默出空页）。
 */
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).trim() : null;
const SELECTED = ONLY ? OFFICIAL.filter((t) => t.style === ONLY || t.slug === ONLY) : OFFICIAL;
if (ONLY && SELECTED.length === 0) {
  console.error(`--only=${ONLY} 没匹配到任何皮肤；可选：${OFFICIAL.map((t) => t.style).join(' / ')}`);
  process.exit(1);
}

const MEMBER = {
  name: '沈砚秋',
  username: 'shenyanqiu',
  memberId: 42,
  bio: '写点曲子，偶尔写点字。凌晨三点最清醒，所以歌都在这个点出来。',
};

// 样例内容：刻意混合「有/无封面」「长/短标题」「歌曲/动态」
// —— 动态与作品走**同一种卡**，这是骨架唯一的硬约束
const ITEMS = [
  { kind: 'song', title: '夜航', meta: 'Dream Pop · 3:47', plays: 3204, cover: true },
  { kind: 'post', title: '关于创作这件事的一点碎念', meta: '@shenyanqiu', excerpt: '凌晨三点最容易想清楚一些白天想不明白的事。写下来就成立了。', likes: 128, comments: 14 },
  { kind: 'song', title: '雾中信号', meta: 'Ambient · 5:12', plays: 1088, cover: true },
  { kind: 'song', title: '海边的旧收音机留下的那首', meta: 'Lo-fi · 2:55', plays: 412, cover: true },
  { kind: 'post', title: '', meta: '@shenyanqiu', excerpt: '今天什么都没做完，但把谱子擦干净了。', likes: 32, comments: 3 },
  { kind: 'song', title: '雪线以上', meta: 'Folk · 4:02', plays: 776, cover: true },
  { kind: 'post', title: '雨落在铁皮屋顶上', meta: '@shenyanqiu', excerpt: '录了段环境音，打算下张专辑用。', likes: 76, comments: 9 },
  { kind: 'song', title: '未寄出的第六首', meta: 'Ambient · 7:20', plays: 98, cover: false },
];

// 样例创作指纹（真实值由服务端 /fingerprint 端点算；这里只验排版）
const FP = {
  days: (() => {
    const out = [];
    for (let i = 0; i < 300; i++) {
      if (i % 7 === 0 || i % 11 === 0 || i < 6) {
        out.push({ day: dayStr(-i), posts: (i % 5) + 1, songs: i % 3 });
      }
    }
    return out;
  })(),
  clock: Array.from({ length: 24 }, (_, h) => (h >= 22 || h <= 4 ? 3 + (h % 4) : h % 3 === 0 ? 2 : 0)),
  genres: [
    { name: '流行', count: 12 },
    { name: '器乐', count: 8 },
    { name: '电子', count: 5 },
    { name: '文字', count: 31 },
  ],
  milestones: [
    { key: 'works', value: 24 },
    { key: 'songs', value: 12 },
    { key: 'posts', value: 86 },
    { key: 'activeDays', value: 143 },
    { key: 'streak', value: 27 },
    { key: 'minutes', value: 1580 },
  ],
};

function dayStr(offsetDays) {
  const d = new Date(Date.UTC(2026, 9, 4) + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 唯一的卡片渲染器（镜像自 ProfileStream.tsx 的 StreamCard）
 *
 * 分层：底纹 → 封面图（压暗）→ 排版大字 → 徽标 → 图标砖。
 * 大字**始终**在场：有图时压在图上（读作封面标题），无图时落在色块上。
 * 色块颜色由 CSS 的 --pt-cover-N 按 nth-child 选，**这里不传任何颜色**。
 */
function streamCardHtml(item) {
  const photo = item.cover
    ? '<span class="community-stream-card__cover-img"></span>'
    : '';
  const letter = `<span class="community-stream-card__letter">${coverLetter(item.title || (item.excerpt ?? '文'))}</span>`;
  const badge = item.plays
    ? `<span class="community-stream-card__badge ds-data">▶ ${item.plays.toLocaleString()}</span>`
    : '';
  const stats =
    item.kind === 'song'
      ? `<span>▶ ${(item.plays ?? 0).toLocaleString()}</span>`
      : `<span>♥ ${item.likes ?? 0}</span><span>💬 ${item.comments ?? 0}</span>`;
  return `<article class="community-stream-card${item.kind === 'song' ? ' community-stream-card--song' : ' community-stream-card--post'}">
  <span class="community-stream-card__cover">
    <span class="community-stream-card__cover-bg"></span>
    ${photo}${letter}${badge}
    <span class="community-stream-card__tile" aria-hidden>${item.kind === 'song' ? '▶' : '💬'}</span>
  </span>
  <div class="community-stream-card__body">
    <h3 class="community-stream-card__title">${item.title || coverLetter(item.excerpt || '动态')}</h3>
    <p class="community-stream-card__meta ds-data"><span class="community-stream-card__kind">${item.kind === 'song' ? '歌曲' : '动态'}</span><span>${item.meta}</span></p>
    ${item.excerpt ? `<p class="community-stream-card__excerpt">${item.excerpt}</p>` : ''}
    <footer class="community-stream-card__foot">
      <span class="community-stream-card__stats ds-data">${stats}</span>
      <time class="community-stream-card__time ds-data">3 天前</time>
      <span class="community-stream-card__go ds-data">打开</span>
    </footer>
  </div>
</article>`;
}

function fingerprintHtml() {
  const heat = fpHeatColumns(FP.days, Date.UTC(2026, 9, 4));
  const miles = fpMilestones(FP.milestones);
  const genres = fpGenres(FP.genres);
  const bars = fpClock(FP.clock);
  const maxGenre = Math.max(1, ...genres.map((g) => g.count));
  return `<section class="community-fp">
  <header class="community-fp__head">
    <h2 class="community-fp__title">创作指纹</h2>
    <span class="community-fp__hint ds-data">来自你的真实创作数据</span>
  </header>
  <ul class="community-fp__miles">
    ${miles.map((m) => `<li class="community-fp__mile"><span class="community-fp__mile-label">${m.text}</span></li>`).join('')}
  </ul>
  <div class="community-fp__heat-wrap">
    <div class="community-fp__heat">
      ${heat
        .map(
          (col) =>
            `<div class="community-fp__heat-col">${col
              .map(
                (c) =>
                  `<span class="community-fp__cell" data-level="${c.level < 0 ? 'void' : c.level}"></span>`,
              )
              .join('')}</div>`,
        )
        .join('')}
    </div>
    <div class="community-fp__heat-legend ds-data">
      <span>少</span>
      ${[0, 1, 2, 3, 4].map((lv) => `<span class="community-fp__cell" data-level="${lv}"></span>`).join('')}
      <span>多</span>
    </div>
  </div>
  <div class="community-fp__clock-wrap">
    <div class="community-fp__clock">
      ${bars
        .map(
          (b) =>
            `<i class="community-fp__clock-bar" data-on="${b.count > 0}" style="--bar:${b.ratio.toFixed(3)}"></i>`,
        )
        .join('')}
    </div>
    <div class="community-fp__clock-axis ds-data">
      <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
    </div>
  </div>
  <div class="community-fp__genres-wrap">
    <div class="community-fp__clock-title ds-data">类型构成</div>
    <ul class="community-fp__genres">
      ${genres
        .map(
          (g) =>
            `<li class="community-fp__genre">
              <span class="community-fp__genre-name">${g.name}</span>
              <span class="community-fp__genre-bar" style="--w:${(g.count / maxGenre).toFixed(3)}"></span>
              <span class="community-fp__genre-count ds-data">${g.count}</span>
            </li>`,
        )
        .join('')}
    </ul>
  </div>
</section>`;
}

/**
 * 海报巨卡 + 混排流
 *
 * 注意：这里**不注入任何颜色**。皮肤由 data-style 决定，颜色全在
 * community.scss 的 [data-style] 块里 —— 这正是 v5 要保证的事：
 * 「换主题只写 CSS」，预览页也得证明这一点（它不能偷偷用 JS 算色）。
 * 所以下面的 style 属性只给作品取色的晕染变量用（--pt-glow）。
 */
function themeHtml(theme) {
  const seal = fpSealSvg(
    `${MEMBER.username}#${MEMBER.memberId}`,
    'var(--pt-text)',
    'var(--color-brand-seal)',
    26,
  );
  return `<div class="community-profile2" data-style="${theme.style}">
  <header class="community-profile2__topbar"><span class="community-profile2__title ds-data">${theme.name}</span></header>

  <header class="community-profile2__poster">
    <div class="community-profile2__poster-glow">
      <span class="poster-photo"></span>
      <span class="community-profile2__poster-wash"></span>
      <span class="community-profile2__poster-veil"></span>
    </div>
    <div class="community-profile2__poster-body">
      <div class="community-profile2__poster-idrow">
        <span class="community-profile2__avatar-tile">
          <span class="community-profile2__avatar">${coverLetter(MEMBER.name)}</span>
        </span>
        <div class="community-profile2__poster-idtext">
          <div class="community-profile2__poster-name">
            <h1 class="community-profile2__name">${MEMBER.name}</h1>
            <span class="community-profile2__lv ds-data">Lv.7</span>
          </div>
          <p class="community-profile2__bio">${MEMBER.bio}</p>
          <div class="community-profile2__meta ds-data">
            <span>@${MEMBER.username}</span>
            <span>杭州</span>
          </div>
        </div>
      </div>
      <div class="community-profile2__stats">
        <span class="community-profile2__stat"><em class="ds-data">24</em><span class="ds-data">作品</span></span>
        <span class="community-profile2__stat"><em class="ds-data">5.6k</em><span class="ds-data">总播放</span></span>
        <span class="community-profile2__stat"><em class="ds-data">312</em><span class="ds-data">粉丝</span></span>
      </div>
      <div class="community-profile2__actions">
        <span class="btn btn--primary">关注</span>
        <span class="btn">发消息</span>
        <span class="btn">分享</span>
      </div>
    </div>
    <span class="community-profile2__seal-mark">${seal}</span>
  </header>

  <nav class="community-profile2__tabs">
    <button class="community-profile2__tab is-active">主页</button>
    <button class="community-profile2__tab">徽章</button>
    <button class="community-profile2__tab">归档</button>
  </nav>

  <div class="community-profile2__works">
    <div class="community-stream__filters">
      <button class="community-stream__filter is-active">全部</button>
      <button class="community-stream__filter">歌曲</button>
      <button class="community-stream__filter">文字</button>
    </div>
    <div class="community-stream__grid">
      ${ITEMS.map((it) => streamCardHtml(it)).join('\n')}
    </div>
    ${fingerprintHtml()}
  </div>
</div>`;
}

/**
 * 从 community.scss 抽取真实规则。
 *
 * 只取「主页皮肤」区块：里面是海报巨卡 / 卡流 / 两套皮肤的定义，
 * 原样交给 sass 编译（浏览器不认 SCSS 嵌套）。
 */
function extractRealScss() {
  const scss = readFileSync(resolve(COMMUNITY, 'community.scss'), 'utf8');
  const start = scss.indexOf('主页皮肤（v4）');
  if (start < 0) {
    throw new Error('community.scss 里找不到「主页皮肤（v4）」标记，SCSS 结构变了');
  }
  const blockStart = scss.lastIndexOf('// =====', start);

  // 主页 = 皮肤区块 + 创作指纹区块。指纹渲染在卡流下面，样式必须一起抽，
  // 否则预览里的热力图/时钟会散架（真实主页不受影响，但预览会骗人）。
  const fpStart = scss.indexOf('// 创作指纹（造物集 D 阶段）', start);
  if (fpStart < 0) {
    throw new Error('community.scss 里找不到「创作指纹」区块标记，指纹样式会散架');
  }
  const fpHead = scss.lastIndexOf('// =====', fpStart);
  return scss.slice(blockStart, fpHead) + '\n' + scss.slice(fpHead);
}

const shellCss = `
/* ===== design-system tokens：必须内联，否则所有间距/字号失效 =====
   少了这一段，页面会挤成一团、字号回落默认值 —— 看着像皮肤做坏了，
   其实只是 token 没注入。预览已经因此骗人一次，别删。 */
${buildTokenCss()}

/* ---- 预览壳：只提供预览页自身的版式（卡片/海报全部走真实 SCSS）---- */

/* 巨卡的封面图占位（真机 = 用户设的封面图）。
 * 注意：不能借用 .community-stream-card__cover-img —— 它编译成后代选择器
 * (.community-stream-card .community-stream-card__cover-img)，在巨卡里匹配不上，
 * 预览已经因此丢过一次封面。 */
.poster-photo {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(
    120deg,
    var(--pt-accent) 0%,
    var(--pt-accent-strong) 48%,
    var(--pt-banner) 100%
  );
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: #16181c;
  color: #e6e8eb;
  font-family: 'Noto Sans SC', system-ui, -apple-system, 'PingFang SC', sans-serif;
  padding: 28px 20px 60px;
}
h1 { font-size: 22px; margin: 0 0 6px; }
.lead { max-width: 900px; font-size: 13px; line-height: 1.7; color: #9aa3ab; margin: 0 0 6px; }
.lead code { background: #23262b; padding: 1px 5px; border-radius: 4px; }
.hint { font-size: 11px; color: #6b7280; margin: 0 0 22px; font-family: ui-monospace, monospace; }
.legend {
  max-width: 900px; margin: 0 0 24px; padding: 14px 16px;
  background: #1d2025; border: 1px solid #2c3037; border-radius: 10px;
  font-size: 12px; line-height: 1.8; color: #a8b0b8;
}
.legend b { color: #e6e8eb; }
.legend table { border-collapse: collapse; margin-top: 8px; font-family: ui-monospace, monospace; }
.legend td { border: 1px solid #2c3037; padding: 3px 8px; }
.grid { display: flex; flex-direction: column; gap: 26px; }
.item { border-radius: 12px; overflow: hidden; }
/* 复刻真机祖先链 .community：flex column + overflow-y:auto + 高度受视口约束。
 * 必须一模一样 —— 主页根节点是它唯一的子项，flex 压缩会把海报压没，
 * 而 body（block）里复现不出来。预览骗过一次人，别让它再骗。
 * 高度给 1600px：够放下整条主页，又能触发"内容超出容器"的滚动路径。 */
.community--preview {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  height: 1600px;
  background-color: var(--color-bg-primary);
}
.item__head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 8px 12px; background: #1d2025; font-size: 12px;
}
.item__head b { font-size: 13px; }
.item__note { color: #8b949e; }

/* 预览壳里没有组件库，模拟一个按钮 */
.btn {
  display: inline-flex; align-items: center;
  padding: 5px 12px; font-size: 12px;
  border: 1px solid var(--pt-border); border-radius: var(--pt-radius);
  color: var(--pt-text); background: var(--pt-surface);
}
.btn--primary { background: var(--pt-accent); color: var(--pt-accent-text); border-color: var(--pt-accent); }

.ds-data { font-family: var(--pt-mono); font-variant-numeric: tabular-nums; }
`;

const { compileString } = await import('sass');
const scssBlock = extractRealScss();
const compiled = compileString(`${scssBlock}`, {
  loadPaths: [resolve(WEB_UI, 'node_modules')],
  silenceDeprecations: ['import', 'legacy-js-api', 'global-builtin', 'color-functions'],
});

const items = SELECTED.map(
  // id 用来深链到某一套皮肤（截图/评审时直接开 #skin-comic），别去掉
  (theme) => `<section class="item" id="skin-${theme.style}">
  <div class="item__head"><b>${theme.name}</b><span class="ds-data">${theme.slug} · style=${theme.style}</span><span class="item__note">${theme.note}</span></div>
  <div class="community community--preview">
  ${themeHtml(theme)}
  </div>
</section>`,
).join('\n');

// 表格里**不列颜色**：颜色在 CSS 里，这里列了反而会让人以为是数据来源
const styleTable = OFFICIAL.map(
  (t) =>
    `<tr><td>${t.name}</td><td>${t.slug}</td><td>${t.style}</td><td>${t.price}</td></tr>`,
).join('');

/**
 * 内联进 <style> 前必须掐掉 @charset。
 *
 * sass 见到非 ASCII 就会在产物开头吐 `@charset "UTF-8";`（Vite 走真实 .css 文件，
 * 有 BOM/@charset 的位置语义，没问题）。但这里是把 CSS 塞进 HTML 的 <style> 里，
 * @charset 只允许出现在样式表**第一个字节**，出现在中间就是非法 at-rule，
 * 浏览器解析器会把**紧随其后那整条规则一起吞掉**。
 *
 * 实测症状（很阴）：被吞掉的正好是 `.community-profile2 { ... }` 根规则，
 * 于是 --pt-bg 永远铺不上，漫画/宣纸的页面底色是宿主页的深色 ——
 * 看起来像"皮肤底色没配"，其实是一条规则被解析器吃掉了。
 */
const stripCharset = (css) => css.replace(/^﻿/, '').replace(/@charset\s+[^;]+;\s*/g, '');

// ⚠️ 下面拼 HTML 时必须插 compiled.css（不是整个 compiled 对象）：
// 新版 sass 的 compileString 返回 CompileResult，直接插值会变成字面量
// "[object Object]"，真实皮肤 CSS 一行都进不了页面 —— 症状是预览页只剩壳样式，
// 主体完全没排版，而脚本自己打印的字节数仍是 16KB（很容易被骗过去）。
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>个人主页 · 2 套皮肤预览</title>
<style>${shellCss}</style>
<style>
/* ===== 以下是从 community.scss 原样抽出的主页皮肤实现（经 sass 编译，未改写）===== */
${stripCharset(compiled.css)}
</style>
</head>
<body>
<h1>个人主页 · 2 套皮肤</h1>
<p class="lead">每块渲染的都是<b>真实骨架</b>：海报巨卡 + 动态与作品混排的<b>同一种卡</b>。
皮肤 CSS <b>直接抽自 <code>community.scss</code> 并原样编译</b>，而本页<b>不注入任何颜色</b> ——
这正是「换主题只写 CSS」的验收点：如果预览还需要 JS 算色，说明这条已经做不到。</p>
<p class="hint">由 scripts/gen-profile-preview.mjs 生成 · 改 SCSS/TS 后重跑即可</p>

<div class="legend">
  <b>一套骨架，两套皮肤</b>：DOM 结构恒定 —— 海报巨卡 + 一条混排流（动态和作品同款卡）。
  皮肤只改三件事：<b>描边语言</b>（粗细 / 有无硬投影 / 虚实）、<b>配色</b>（15 个 <code>--pt-*</code> + 6 个 <code>--pt-cover-*</code>）、
  <b>装饰</b>（图标砖 / 撒花 / 药丸）。
  <b>加第三套皮肤</b> = 在 community.scss 里加一个 <code>[data-style='xxx']</code> 块，
  不用改 themes.ts、不用写 DB 迁移、不用改测试常量表。
  <table>
    <tr><td>主题</td><td>slug</td><td>style</td><td>价格</td></tr>
    ${styleTable}
  </table>
</div>

<div class="grid">${items}</div>
</body>
</html>
`;

const outDir = resolve(CLIENT, 'dist/profile-preview');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'index.html');
writeFileSync(outFile, html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
console.log(`\n✅ 预览页已生成：${outFile}`);
console.log(`  皮肤 ${SELECTED.length} 套${ONLY ? `（仅 ${ONLY}）` : ''} · 体积 ${kb(Buffer.byteLength(html))} · 真实 CSS ${kb(Buffer.byteLength(compiled.css))}`);
console.log(`  打开：start "" "${outFile}"`);
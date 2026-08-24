/**
 * 灵印品牌资产生成器（规范 2.5 · v0.9 字形）
 *
 * 字形与 src/components/brand-mark.tsx 完全同源（viewBox 24×24）：
 *   X   两对角粗笔 (3,3)↔(21,21)，笔宽 4（圆头），中段被环内 mask 擦除，四角冒头
 *   环  正圆 c(12,12) r=8.5，环宽 1.6——镂空圆脸（「靈」之口），印心透底
 *   眼  实心圆 r=1.5，c(8.5,12)/(15.5,12)——与环同色（「雨」/ai00 之 00）
 *
 * 输出（pnpm --filter @ai00-x/design-system run brand:icons）：
 *   client/src/apps/desktop/icons/brand-1024.png   朱砂 1024×1024 透明底（tauri icon 源）
 *   client/src/apps/desktop/icons/Logo-ICON.png    朱砂 512×512（relay homepage / copy-icons 源）
 *   client/src/{web-ui,loader-ui,underlay-ui}/public/favicon.png   朱砂 32×32
 *   同上目录 favicon.svg                            明暗自适应（亮=深墨 暗=宣纸白）
 *
 * 颜色为品牌资产固定值（不随主题/hue 联动，规范 v0.4 sRGB 定版）：
 *   朱砂 #bd4a33 · 深墨 #16171c · 宣纸白 #f6f2e8
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientRoot = resolve(pkgRoot, '../..');

/** 品牌资产色（v0.11 松烟墨冷青，规范 sRGB 定版） */
const SEAL = '#bd4a33';
const INK = '#16191a';
const PAPER = '#f6f2e8';

/** 灵印字形 SVG（几何参数与 brand-mark.tsx 逐一对应） */
function lingSvg({ color, size }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">
  <defs>
    <mask id="core" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
      <rect width="24" height="24" fill="white"/>
      <circle cx="12" cy="12" r="8.5" fill="black"/>
    </mask>
  </defs>
  <g stroke="${color}" stroke-width="4" stroke-linecap="round" mask="url(#core)">
    <line x1="3" y1="3" x2="21" y2="21"/>
    <line x1="21" y1="3" x2="3" y2="21"/>
  </g>
  <circle cx="12" cy="12" r="8.5" fill="none" stroke="${color}" stroke-width="1.6"/>
  <circle cx="8.5" cy="12" r="1.5" fill="${color}"/>
  <circle cx="15.5" cy="12" r="1.5" fill="${color}"/>
</svg>`;
}

/** favicon.svg：明暗自适应（亮=深墨 / 暗=宣纸白，prefers-color-scheme） */
function faviconAdaptiveSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <style>
    .ling { color: ${INK}; }
    @media (prefers-color-scheme: dark) { .ling { color: ${PAPER}; } }
  </style>
  <defs>
    <mask id="core" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
      <rect width="24" height="24" fill="white"/>
      <circle cx="12" cy="12" r="8.5" fill="black"/>
    </mask>
  </defs>
  <g class="ling" stroke="currentColor" stroke-width="4" stroke-linecap="round" mask="url(#core)">
    <line x1="3" y1="3" x2="21" y2="21"/>
    <line x1="21" y1="3" x2="3" y2="21"/>
  </g>
  <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="8.5" cy="12" r="1.5" fill="currentColor"/>
  <circle cx="15.5" cy="12" r="1.5" fill="currentColor"/>
</svg>`;
}

function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
}

function write(dir, name, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), data);
  console.log(`  ✓ ${resolve(dir, name)}`);
}

console.log('灵印品牌资产生成（v0.9 字形：镂空圆脸擦 X，四角冒头）');

// 1. 客户端图标源资产（朱砂，透明底）
const iconsDir = resolve(clientRoot, 'src/apps/desktop/icons');
write(iconsDir, 'brand-1024.png', renderPng(lingSvg({ color: SEAL, size: 1024 }), 1024));
write(iconsDir, 'Logo-ICON.png', renderPng(lingSvg({ color: SEAL, size: 512 }), 512));

// 2. 各前端 favicon（PNG 朱砂 32 + SVG 明暗自适应）
for (const ui of ['web-ui', 'loader-ui', 'underlay-ui']) {
  const dir = resolve(clientRoot, `src/${ui}/public`);
  write(dir, 'favicon.png', renderPng(lingSvg({ color: SEAL, size: 32 }), 32));
  write(dir, 'favicon.svg', faviconAdaptiveSvg());
}

// 3. Linux hicolor 全尺寸（deb 打包引用 ai00-x-desktop.png）
const HICOLOR_SIZES = [16, 32, 48, 64, 96, 128, 256, 512];
for (const s of HICOLOR_SIZES) {
  const dir = resolve(clientRoot, `src/apps/desktop/icons/hicolor/${s}x${s}/apps`);
  write(dir, 'ai00-x-desktop.png', renderPng(lingSvg({ color: SEAL, size: s }), s));
}

console.log('完成。后续：pnpm tauri icon src/apps/desktop/icons/brand-1024.png --output src/apps/desktop/icons');

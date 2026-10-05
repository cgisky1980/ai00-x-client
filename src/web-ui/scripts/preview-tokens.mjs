/**
 * 给预览页注入真机 token
 *
 * 背景（踩过的坑，务必别删）：预览页是独立 HTML，只注入 --pt-*（主题色板）。
 * 但 community.scss 里所有间距/字号/圆角/字体栈都走**应用级 token**
 * （--size-gap-* / --font-size-* / --size-radius-* / --font-family-* /
 *   --color-brand-seal / --modal-overlay …），预览页里没有这些 → 全部失效：
 * padding 归零、gap 归零、字号回落默认。
 * 症状是页面"挤成一团、字全是默认大小、看不出皮肤差别"——
 * **看起来像皮肤做坏了，其实是 token 没注入**。预览骗人过一次，别让它再骗。
 *
 * 做法：直接内联 packages/design-system/css/tokens.css（26KB，真值来源，
 * DTCG 直出），不手抄、不重算 —— 手抄一份就等于又埋一个不一致的坑。
 */
import { readFileSync } from 'node:fs';

const TOKENS_CSS = 'C:/work/ai00-x-dev/client/packages/design-system/css/tokens.css';

export function buildTokenCss() {
  // @charset 同 gen-profile-preview 里的坑：内联进 <style> 后它出现在样式表中间，
  // 属非法 at-rule，浏览器会把紧随其后那条规则吞掉。这里没有非 ASCII，本来也不会有，
  // 仍然掐掉 —— 免得以后给 tokens.css 加了中文注释就静默回归。
  const css = readFileSync(TOKENS_CSS, 'utf8').replace(/^﻿/, '').replace(/@charset\s+[^;]+;\s*/g, '');
  // 亮档强制（预览页没有主题切换，也不需要暗档对比）
  return `/* ===== design-system tokens（原样内联；亮档强制）===== */
[data-theme-type='light'],
:root {
  color-scheme: light;
}
${css}`;
}
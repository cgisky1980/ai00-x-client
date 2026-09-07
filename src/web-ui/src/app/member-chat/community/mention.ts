/**
 * mention — @提及辅助（P1.2）
 *
 * 用户名约定：ASCII 字母/数字/下划线/连字符，1..32（与服务端 parse_mentions 同规则）。
 * - 输入补全：从光标前文本提取 `@query`（MENTION_QUERY_RE）
 * - 渲染：把正文中的 `@username` 预处理为 `[@username](#mention/username)` 链接
 *   （跳过围栏代码块与行内代码；`@` 前是 ASCII 词字符/. 时视为邮箱等，不误伤），
 *   配合 MentionLinkify 的点击捕获实现"点击提及 → 打开主页"
 */
import { chatApi } from '../chatApi';

export const MENTION_USERNAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 光标前文本中的补全 query（null=不在 @ 补全态）。@ 需在行首或其前不是 ASCII 词字符/.（排除邮箱） */
export function extractMentionQuery(textBeforeCaret: string): string | null {
  const lineStart = textBeforeCaret.lastIndexOf('\n') + 1;
  const line = textBeforeCaret.slice(lineStart);
  const m = /@([A-Za-z0-9_-]{0,32})$/.exec(line);
  if (!m) return null;
  const idx = line.length - m[0].length;
  const prev = idx > 0 ? line[idx - 1] : '';
  if (/[A-Za-z0-9._-]/.test(prev)) return null;
  return m[1];
}

/** 选中候选：把光标前 `@query` 替换为 `@username ` */
export function applyMention(
  value: string,
  caret: number,
  username: string,
): { value: string; caret: number } {
  const before = value.slice(0, caret);
  const m = /@([A-Za-z0-9_-]{0,32})$/.exec(before);
  if (!m) return { value, caret };
  const start = caret - m[0].length;
  const inserted = `@${username} `;
  return {
    value: value.slice(0, start) + inserted + value.slice(caret),
    caret: start + inserted.length,
  };
}

/** 成员搜索（防抖/缓存由调用方 hint 与补全面板各自处理；此处薄封装） */
export function searchMentionMembers(query: string) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return chatApi
    .searchMembers(q, 8)
    .then((r) => r.hits)
    .catch(() => []);
}

/* ---------- 渲染预处理 ---------- */

const MENTION_TOKEN_RE = /@([A-Za-z0-9_-]{1,32})/g;

/** 单段（非代码）文本中的提及 → 链接；@ 前 ASCII 词字符/. 的（邮箱）不转换 */
function linkifySegment(seg: string): string {
  return seg.replace(MENTION_TOKEN_RE, (match, name: string, offset: number) => {
    const prev = offset > 0 ? seg[offset - 1] : '';
    if (/[A-Za-z0-9._-]/.test(prev)) return match;
    return `[@${name}](#mention/${name})`;
  });
}

/** 正文提及预处理：跳过 ``` 围栏与行内代码段 */
export function linkifyMentions(content: string): string {
  const lines = content.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // 行内代码段（奇数段为代码）不转换
    const parts = line.split('`');
    return parts.map((p, i) => (i % 2 === 0 ? linkifySegment(p) : p)).join('`');
  });
  return out.join('\n');
}

/** 从 #mention/{username} href 提取用户名 */
export function parseMentionHref(href: string): string | null {
  const m = /^#mention\/([A-Za-z0-9_-]{1,32})$/.exec(href);
  return m ? m[1] : null;
}

/** 用户名 → member id（精确匹配；搜索前缀命中但用户名不同则 null） */
export async function resolveMentionId(username: string): Promise<number | null> {
  const hits = await searchMentionMembers(username);
  const exact = hits.find((h) => h.username === username);
  return exact ? exact.id : null;
}

/* ---------- 纯文本渲染分段（CommentItem 等非 Markdown 场景） ---------- */

export type MentionSegment = { kind: 'text'; text: string } | { kind: 'mention'; name: string };

/** 把纯文本按 @提及 切段（@ 前 ASCII 词字符/. 的不切，排除邮箱） */
export function splitMentionParts(text: string): MentionSegment[] {
  const parts: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const offset = match.index ?? 0;
    const prev = offset > 0 ? text[offset - 1] : '';
    if (/[A-Za-z0-9._-]/.test(prev)) continue;
    if (offset > last) parts.push({ kind: 'text', text: text.slice(last, offset) });
    parts.push({ kind: 'mention', name: match[1] });
    last = offset + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

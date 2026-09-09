/**
 * mdToPlain — 将 Markdown 源文压成纯文本摘要（feed 卡片用）。
 *
 * 图片整段剔除；链接保留文字；代码块/行内代码保留内容；
 * 去掉强调/标题/引用/列表等行内与行首标记；HTML 标签剔除。
 */

export function mdToPlain(md: string): string {
  return md
    // 代码块 → 保留内容
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, '$1')
    // 图片整段剔除（行内式 + 引用式）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    // 链接 → 文字
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // 行内代码 → 内容
    .replace(/`([^`]+)`/g, '$1')
    // 强调/删除线标记
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // 行首标记：标题/引用/列表/任务
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+(\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // HTML 标签剔除
    .replace(/<[^>]+>/g, '')
    // 多余空行收敛
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MdPreview {
  /** 文档首行 ATX 标题（#/##/###，行内标记已剥离）；无则 null */
  title: string | null;
  /** 剥离全部 MD 语法并压平换行的纯文本摘要（CSS line-clamp 截断） */
  body: string;
  /** 正文首张行内图片 URL（未上传附件时 feed 卡封面用）；无则 null */
  firstImage: string | null;
}

/**
 * mdPreview — feed 卡片预览三元组（标题/摘要/首图）。
 *
 * 标题只认文档首个非空行的 ATX 标题（不在正文中段找章节标题），
 * 且该行会从摘要中剔除；摘要把换行压平成连续段落，配合 line-clamp 展示；
 * 首图取正文第一张行内图片（封面字段之外的兜底视觉锚点）。
 */
export function mdPreview(md: string): MdPreview {
  const lines = md.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  let title: string | null = null;
  if (firstIdx >= 0) {
    const m = lines[firstIdx].match(/^[ \t]{0,3}#{1,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (m) title = mdToPlain(m[1]);
  }
  const bodyLines = firstIdx >= 0 && title ? lines.filter((_, i) => i !== firstIdx) : lines;
  const body = mdToPlain(bodyLines.join('\n'))
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const img = md.match(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/);
  return { title, body, firstImage: img ? img[1] : null };
}

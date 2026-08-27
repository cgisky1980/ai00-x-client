/**
 * planAcceptance — 计划 MD「## 验收」段的解析与勾选回写。
 *
 * 唯一真源 = 计划文档 MD 的 `- [ ]`/`- [x]` 勾选态（人与 agent 对等读写
 * 同一文件）；本工具负责 MD ↔ 结构化 的双向转换。
 */

export interface AcceptanceItem {
  /** 行在 MD 中的行号（回写定位） */
  lineIndex: number;
  text: string;
  done: boolean;
}

/** 解析 MD 的「## 验收」段（无段/无项 → 空数组 = 免验收）。 */
export function parseAcceptance(md: string | null): AcceptanceItem[] {
  if (!md) return [];
  const lines = md.split('\n');
  const items: AcceptanceItem[] = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inSection = /^##\s*验收/.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (m) items.push({ lineIndex: i, text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
  }
  return items;
}

/** 勾选/取消一项：改写 MD 对应行（`- [ ]` ↔ `- [x]`），返回新 MD。 */
export function toggleAcceptanceLine(md: string, lineIndex: number, done: boolean): string {
  const lines = md.split('\n');
  const line = lines[lineIndex];
  if (line == null) return md;
  lines[lineIndex] = line.replace(/^\s*-\s+\[([ xX])\]/, done ? '- [x]' : '- [ ]');
  return lines.join('\n');
}

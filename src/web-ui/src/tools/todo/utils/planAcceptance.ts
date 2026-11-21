/**
 * planAcceptance — 计划 MD「## 验收」/「## 步骤」段的解析与勾选回写。
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

/** 解析 MD 的「## 验收」段（中英标题都认；无段/无项 → 空数组 = 免验收）。 */
export function parseAcceptance(md: string | null): AcceptanceItem[] {
  return parseSectionItems(md, ['验收', 'acceptance']);
}

/** 解析 MD 的「## 步骤」段（带行号；旧数字列表格式无 checkbox → 空数组）。 */
export function parseStepItems(md: string | null): AcceptanceItem[] {
  return parseSectionItems(md, ['步骤', 'steps', 'step']);
}

function parseSectionItems(md: string | null, sections: string[]): AcceptanceItem[] {
  if (!md) return [];
  const lines = md.split('\n');
  const items: AcceptanceItem[] = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inSection = sections.some((section) => new RegExp(`^##\\s*${section}`, 'i').test(line));
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (m) items.push({ lineIndex: i, text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
  }
  return items;
}

/**
 * 解析 MD 的「## 步骤」段勾选态 → 执行进度。
 * current = 首个未勾项标题（当前步骤）；旧数字列表格式（无 checkbox）→
 * total=0（不显示进度，不报错）。
 */
export function parseSteps(md: string | null): {
  done: number;
  total: number;
  current: string | null;
} {
  const items = parseStepItems(md);
  const firstUndone = items.find(i => !i.done);
  return {
    done: items.filter(i => i.done).length,
    total: items.length,
    current: firstUndone ? firstUndone.text.replace(/^\d+[.、]\s*/, '').slice(0, 40) : null,
  };
}

/** 勾选/取消一项：改写 MD 对应行（`- [ ]` ↔ `- [x]`），返回新 MD。 */
export function toggleAcceptanceLine(md: string, lineIndex: number, done: boolean): string {
  const lines = md.split('\n');
  const line = lines[lineIndex];
  if (line == null) return md;
  lines[lineIndex] = line.replace(/^\s*-\s+\[([ xX])\]/, done ? '- [x]' : '- [ ]');
  return lines.join('\n');
}

/**
 * 把「## 验收」段所有勾选清零。
 *
 * 人类打回时的必要动作：只清 `agentCompletedAt` 的话，验收清单仍是全勾，
 * agent 下一轮可以直接重新提交自检（`ai00_task_complete` 只要求勾选齐全），
 * 打回就变成摆设。清零后 DoD 重新不成立，必须先修正产物再逐项确认。
 */
export function uncheckAcceptance(md: string): string {
  const lines = md.split('\n');
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inSection = /^##\s*(验收|acceptance)/i.test(line);
      continue;
    }
    if (!inSection) continue;
    lines[i] = line.replace(/^(\s*-\s+)\[[xX]\]/, '$1[ ]');
  }
  return lines.join('\n');
}

/** 在「## 验收」段末尾追加一行打回记录（非 checkbox，不参与勾选统计）。 */
export function appendRejectNote(md: string, reason: string, stamp = ''): string {
  const lines = md.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s/.test(lines[i])) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (/^##\s*(验收|acceptance)/i.test(lines[i])) start = i;
  }
  if (start < 0) return md;
  const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  const note = `- 打回: ${clean}${stamp ? ` · ${stamp}` : ''}`;
  // 段尾若有空行，插在空行之前，保持 Markdown 段结构
  let at = end;
  while (at > start + 1 && (lines[at - 1] ?? '').trim() === '') at -= 1;
  lines.splice(at, 0, note);
  return lines.join('\n');
}

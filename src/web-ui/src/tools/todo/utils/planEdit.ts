/**
 * planEdit — 计划书「## 步骤」段的就地编辑（纯函数，回写整份 Markdown）。
 *
 * 只改动目标步骤块的行，其余内容（其它段、注释、未知字段）原样保留；
 * 步骤块 = 从 `- [ ] T<id> 标题` 行起，到下一个步骤头 / 下一个二级标题之前。
 * 定位一律用 `parsePlanSteps` 给出的绝对行号 `lineIndex`。
 */
import { parsePlanSteps, type PlanStep } from './planStructure';

const STEP_HEAD = /^(\s*-\s+\[[ xX]\]\s+)(T[0-9A-Za-z_-]+)(\s+)(.*)$/;
const ACCEPT_PROP = /^(\s*-\s*(?:验收|acceptance)\s*[:：]\s*)(.*)$/i;
const CMD_SUFFIX = /\s*\{cmd:\s*.+?\}\s*$/;

/** 步骤块的 [start, end) 行区间。 */
function blockRange(lines: string[], lineIndex: number): [number, number] {
  let end = lineIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^##\s/.test(line) || STEP_HEAD.test(line)) break;
    end += 1;
  }
  // 块尾的空行留给下一块，避免删除步骤时吞掉段落间距
  while (end > lineIndex + 1 && lines[end - 1].trim() === '') end -= 1;
  return [lineIndex, end];
}

/** 子项缩进：沿用块内第一条子项，没有则两个空格。 */
function childIndent(lines: string[], start: number, end: number): string {
  for (let i = start + 1; i < end; i += 1) {
    const match = /^(\s+)-\s/.exec(lines[i]);
    if (match) return match[1];
  }
  return '  ';
}

export function setStepTitle(md: string, lineIndex: number, title: string): string {
  const lines = md.split('\n');
  const match = STEP_HEAD.exec(lines[lineIndex] ?? '');
  if (!match) return md;
  lines[lineIndex] = `${match[1]}${match[2]}${match[3]}${title.trim()}`;
  return lines.join('\n');
}

/**
 * 设置步骤首条验收的 `{cmd: …}`；空串 = 去掉命令。
 * 没有验收行时在块内追加一条 `- Acceptance: {cmd: …}`。
 */
export function setStepCommand(md: string, lineIndex: number, cmd: string): string {
  const lines = md.split('\n');
  if (!STEP_HEAD.test(lines[lineIndex] ?? '')) return md;
  const [start, end] = blockRange(lines, lineIndex);
  const next = cmd.trim();
  for (let i = start + 1; i < end; i += 1) {
    const match = ACCEPT_PROP.exec(lines[i]);
    if (!match) continue;
    const text = match[2].replace(CMD_SUFFIX, '').trim();
    const value = next ? `${text ? `${text} ` : ''}{cmd: ${next}}` : text;
    lines[i] = `${match[1]}${value}`;
    return lines.join('\n');
  }
  if (!next) return md;
  lines.splice(end, 0, `${childIndent(lines, start, end)}- Acceptance: {cmd: ${next}}`);
  return lines.join('\n');
}

export function deleteStep(md: string, lineIndex: number): string {
  const lines = md.split('\n');
  if (!STEP_HEAD.test(lines[lineIndex] ?? '')) return md;
  const [start, end] = blockRange(lines, lineIndex);
  lines.splice(start, end - start);
  return lines.join('\n');
}

/** 下一个可用编号：现有 `T<数字>` 的最大值 + 1。 */
export function nextStepId(steps: PlanStep[]): string {
  let max = 0;
  for (const step of steps) {
    const n = /^T(\d+)$/.exec(step.id);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `T${max + 1}`;
}

/**
 * 在步骤段末尾追加一步；返回新 Markdown 与新步骤编号。
 * 没有步骤段时不改动（由调用方提示改用源码编辑）。
 */
export function appendStep(md: string, title: string): { md: string; id: string } | null {
  const steps = parsePlanSteps(md);
  const lines = md.split('\n');
  const id = nextStepId(steps);
  const last = steps[steps.length - 1];
  if (!last) return null;
  const [, end] = blockRange(lines, last.lineIndex);
  const prefix = STEP_HEAD.exec(lines[last.lineIndex])?.[1].replace(/\[[xX]\]/, '[ ]') ?? '- [ ] ';
  lines.splice(end, 0, `${prefix}${id} ${title.trim()}`);
  return { md: lines.join('\n'), id };
}

export interface PlanStepDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

/** 两版计划的步骤差异（按 T 编号比较标题与验收）。 */
export function diffPlanSteps(before: string | null, after: string | null): PlanStepDiff {
  const prev = new Map(parsePlanSteps(before).map((s) => [s.id, s]));
  const next = new Map(parsePlanSteps(after).map((s) => [s.id, s]));
  const diff: PlanStepDiff = { changed: [], added: [], removed: [] };
  const fingerprint = (s: PlanStep): string =>
    JSON.stringify([s.title, s.acceptance, s.dependencies, s.paths, s.implementation, s.risk]);
  for (const [id, step] of next) {
    const old = prev.get(id);
    if (!old) diff.added.push(id);
    else if (fingerprint(old) !== fingerprint(step)) diff.changed.push(id);
  }
  for (const id of prev.keys()) if (!next.has(id)) diff.removed.push(id);
  return diff;
}

export function isEmptyDiff(diff: PlanStepDiff): boolean {
  return diff.changed.length + diff.added.length + diff.removed.length === 0;
}

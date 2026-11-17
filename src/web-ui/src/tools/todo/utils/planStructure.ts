/**
 * planStructure — 工作台计划书的结构化解析（五段契约）。
 *
 * 契约（由工作台 loop 提示与宿主 AGENTS.local.md 写入）：
 *   ## 执行策略 / ## 目标 / ## 步骤 / ## 验收 / ## 交付物
 * 步骤块：
 *   - [ ] T1 标题
 *     - 依赖: none | T0, T1
 *     - 风险: low | medium | high
 *     - 范围: a.ts, b.ts
 *     - 实施细则: ...
 *     - 验收: ... {cmd: 白名单命令}
 *     - 验证: passed · 2026-11-10 10:21   （ai00_task_verify 回写）
 *     - 证据: type-check ✓ · 变更 2 文件   （ai00_task_verify 回写）
 *     - 状态: 返工                        （编排者可选覆盖）
 *
 * 兼容：旧计划（无 T 编号 / 无策略段）解析结果为空，由调用方降级到
 * 三态进度 + 文本验收（planAcceptance.ts）。
 */

export type PlanStepState =
  | 'todo'
  | 'active'
  | 'review'
  | 'rework'
  | 'done'
  | 'fallback'
  | 'failed';

export type PlanRisk = 'low' | 'medium' | 'high' | 'unknown';

export interface PlanStepAcceptance {
  text: string;
  /** `{cmd: ...}` 提取出的验证命令；纯人工判据为 null。 */
  cmd: string | null;
}

export interface PlanStepVerification {
  verdict: 'passed' | 'failed' | 'needs-review';
  /** 回写的验证时间（原样展示）。 */
  at?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  done: boolean;
  /** 勾选行在 MD 中的行号（人类代勾回写用）。 */
  lineIndex: number;
  dependencies: string[];
  risk: PlanRisk;
  paths: string[];
  implementation: string;
  acceptance: PlanStepAcceptance[];
  verification: PlanStepVerification | null;
  evidence: string;
  explicitState: PlanStepState | null;
}

export interface PlanPolicy {
  execution: 'local-first' | 'legacy';
  review: 'adaptive' | 'strict';
}

const DEFAULT_POLICY: PlanPolicy = { execution: 'legacy', review: 'adaptive' };

/** 取某个二级标题段的正文行；未找到返回 null。 */
function sectionLines(md: string | null, heading: RegExp): string[] | null {
  if (!md) return null;
  const lines = md.split('\n');
  const result: string[] = [];
  let inside = false;
  let found = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inside = heading.test(line);
      if (inside) found = true;
      continue;
    }
    if (inside) result.push(line);
  }
  return found ? result : null;
}

/** 段标题中英别名（旧中文计划与英文模板都认）。 */
const HEADING = {
  policy: /^##\s*(执行策略|Execution Policy)/i,
  steps: /^##\s*(步骤|Steps?)/i,
  goal: /^##\s*(目标|Goals?)/i,
  deliverables: /^##\s*(交付物|Deliverables?)/i,
  acceptance: /^##\s*(验收|Acceptance)/i,
};

/** 步骤字段中英归一。 */
const FIELD_ALIASES: Record<string, string> = {
  依赖: '依赖',
  'depends on': '依赖',
  dependencies: '依赖',
  dependency: '依赖',
  风险: '风险',
  risk: '风险',
  范围: '范围',
  scope: '范围',
  paths: '范围',
  实施细则: '实施细则',
  implementation: '实施细则',
  验收: '验收',
  acceptance: '验收',
  验证: '验证',
  verification: '验证',
  evidence: '证据',
  证据: '证据',
  状态: '状态',
  state: '状态',
  status: '状态',
};

/** `{cmd: ...}` 提取（与 dsh-tools 插件同一护栏）。 */
function extractCmd(text: string): string | null {
  const match = /\{cmd:\s*(.+?)\}\s*$/.exec(text);
  if (!match) return null;
  const cmd = match[1].trim();
  if (!cmd || cmd.length > 500) return null;
  if (/`|\$\(|&&\s*rm|;\s*rm/.test(cmd)) return null;
  return cmd;
}

/** 执行策略：缺段/缺项 = 旧计划（legacy + adaptive）。 */
export function parsePlanPolicy(md: string | null): PlanPolicy {
  const lines = sectionLines(md, HEADING.policy);
  if (!lines) return { ...DEFAULT_POLICY };
  const policy: PlanPolicy = { ...DEFAULT_POLICY };
  for (const line of lines) {
    const match = /^\s*-\s*(执行方式|云端复审|Execution|Review)\s*[:：]\s*(.+)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().toLowerCase();
    if (key === '执行方式' || key === 'execution') {
      policy.execution = value === 'local-first' ? 'local-first' : 'legacy';
    } else {
      policy.review = value === 'strict' ? 'strict' : 'adaptive';
    }
  }
  return policy;
}

function normalizeRisk(value: string): PlanRisk {
  const risk = value.toLowerCase();
  if (risk === 'low' || risk === 'medium' || risk === 'high') return risk;
  return 'unknown';
}

function normalizeState(value: string): PlanStepState | null {
  switch (value.trim().toLowerCase()) {
    case '待办':
    case 'todo':
      return 'todo';
    case '进行中':
    case 'active':
    case 'running':
      return 'active';
    case '待评审':
    case 'review':
    case 'in review':
      return 'review';
    case '返工':
    case 'rework':
      return 'rework';
    case '已通过':
    case 'done':
    case 'passed':
      return 'done';
    case '兜底':
    case 'fallback':
      return 'fallback';
    case '失败':
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

function normalizeVerdict(value: string): PlanStepVerification | null {
  const head = value.split(/[·|]/)[0]?.trim().toLowerCase();
  const at = value.includes('·') ? value.split('·').slice(1).join('·').trim() : undefined;
  if (head === 'passed' || head === 'failed' || head === 'needs-review') {
    return { verdict: head, ...(at ? { at } : {}) };
  }
  return null;
}

/**
 * 解析「## 步骤」为结构化任务列表。
 * 只有带 `T<id>` 的块才返回；旧计划的普通勾选项返回空数组。
 */
export function parsePlanSteps(md: string | null): PlanStep[] {
  if (!md) return [];
  // 行号必须是相对整份 MD 的绝对行号（人类代勾要回写同一行）
  const allLines = md.split('\n');
  const steps: PlanStep[] = [];
  let current: PlanStep | null = null;
  let insideSection = false;

  for (let index = 0; index < allLines.length; index++) {
    const raw = allLines[index];
    if (/^##\s/.test(raw)) {
      insideSection = HEADING.steps.test(raw);
      // 步骤段结束后即可停止（后面的「## 验收」不再属于步骤）
      if (!insideSection && current) break;
      continue;
    }
    if (!insideSection) continue;

    const head = /^\s*-\s+\[([ xX])\]\s+(T[0-9A-Za-z_-]+)\s+(.*)$/.exec(raw);
    if (head) {
      current = {
        id: head[2],
        title: head[3].trim(),
        done: head[1].toLowerCase() === 'x',
        lineIndex: index,
        dependencies: [],
        risk: 'unknown',
        paths: [],
        implementation: '',
        acceptance: [],
        verification: null,
        evidence: '',
        explicitState: null,
      };
      steps.push(current);
      continue;
    }
    if (!current) continue;

    const prop = /^\s*-\s*([^:：]{1,24})[:：]\s*(.*)$/.exec(raw);
    if (!prop) continue;
    const field = FIELD_ALIASES[prop[1].trim().toLowerCase()];
    if (!field) continue;
    const value = prop[2].trim();
    switch (field) {
      case '依赖':
        current.dependencies = /^none$/i.test(value)
          ? []
          : value.split(/[,，\s]+/).filter(Boolean);
        break;
      case '风险':
        current.risk = normalizeRisk(value);
        break;
      case '范围':
        current.paths = value
          .split(/[,，]/)
          .map(item => item.trim())
          .filter(Boolean);
        break;
      case '实施细则':
        current.implementation = value;
        break;
      case '验收':
        if (value) current.acceptance.push({ text: value, cmd: extractCmd(value) });
        break;
      case '验证':
        current.verification = normalizeVerdict(value);
        break;
      case '证据':
        current.evidence = value;
        break;
      case '状态':
        current.explicitState = normalizeState(value);
        break;
      default:
        break;
    }
  }

  return steps;
}

/** 「## 目标」段的首行非空文本。 */
export function parsePlanGoal(md: string | null): string {
  const lines = sectionLines(md, HEADING.goal);
  if (!lines) return '';
  for (const line of lines) {
    const text = line.replace(/^\s*[-*]\s*/, '').trim();
    if (text) return text;
  }
  return '';
}

/** 「## 交付物」段：优先勾选项文本，否则按行取。 */
export function parsePlanDeliverables(md: string | null): string[] {
  const lines = sectionLines(md, HEADING.deliverables);
  if (!lines) return [];
  const items: string[] = [];
  for (const line of lines) {
    const checkbox = /^\s*-\s+\[[ xX]\]\s+(.*)$/.exec(line);
    if (checkbox) {
      const text = checkbox[1].trim();
      if (text) items.push(text);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const text = bullet[1].trim();
      if (text) items.push(text);
    }
  }
  return items;
}

export interface DeriveStepOptions {
  /** 当前进行中的步骤索引（来自首个未完成项）；null = 不标进行中。 */
  activeIndex: number | null;
  index: number;
  taskCompleted: boolean;
  /** 任务会话正在运行（未运行的"未完成"不标进行中）。 */
  running: boolean;
}

/**
 * 单步展示状态：
 * 显式状态 > 已完成 > 验证失败/需评审 > 进行中 > 待办。
 * 「兜底」只来自显式状态，避免把失败误判成兜底。
 */
export function deriveStepState(
  step: PlanStep,
  options: DeriveStepOptions,
): PlanStepState {
  if (options.taskCompleted) return 'done';
  if (step.explicitState) return step.explicitState;
  if (step.done) return 'done';
  if (step.verification?.verdict === 'failed') return 'rework';
  if (step.verification?.verdict === 'needs-review') return 'review';
  if (options.running && options.activeIndex === options.index) return 'active';
  return 'todo';
}

/** 汇总风险计数（只统计已知风险）。 */
export function countRisks(steps: PlanStep[]): Record<PlanRisk, number> {
  const counts: Record<PlanRisk, number> = { low: 0, medium: 0, high: 0, unknown: 0 };
  for (const step of steps) counts[step.risk] += 1;
  return counts;
}

/**
 * check-workbench-contract.mjs — 工作台 loop 契约两份副本的一致性门禁。
 *
 * loop 规约有**两份物理副本**（同一份口径，改一处必须同步另一处）：
 *   ① web-ui 首条 prompt：`src/web-ui/src/agent/orchestrator/promptParts.ts`
 *   ② 宿主写进任务的 AGENTS.local.md：`src/apps/desktop/src/api/workbench_api.rs`
 *
 * 实测两次漂移（Rust 副本整段缺了「Wrap-up 要跑集成验收」），而两份都各自"看起来对"，
 * 直到 agent 依 AGENTS 执行才发现。这里把两份规约都抓下来做逐条比对：
 * 编号项必须逐字一致（空白归一后），任何差异打印出来并以 exit 1 结束。
 *
 * 用法：node scripts/check-workbench-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TS_PATH = join(root, 'src/web-ui/src/agent/orchestrator/promptParts.ts');
const RS_PATH = join(root, 'src/apps/desktop/src/api/workbench_api.rs');

/**
 * 归一化：空白折叠 + 反引号（只是 Markdown 强调，不影响给 agent 的语义）+ 任务 id 插值占位。
 * 其余逐字比对——文案差异就是口径差异。
 */
function norm(text) {
  return text
    .replace(/`/g, '')
    .replace(/taskId:\s*"[^"]*"/g, 'taskId: <id>')
    // Rust 侧 plan_hint 是 format 变量：等价于 TS 那句 ai00_plan_write (taskId: "<id>")
    .replace(/__TASK_HINT__/g, 'ai00_plan_write (taskId: <id>)')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 抽出 TS 侧 WORKBENCH_LOOP_RULES 的字符串数组元素。 */
function readTsRules() {
  const source = readFileSync(TS_PATH, 'utf8');
  const start = source.indexOf('export const WORKBENCH_LOOP_RULES');
  if (start < 0) throw new Error('WORKBENCH_LOOP_RULES not found in promptParts.ts');
  const end = source.indexOf('].join(', start);
  if (end < 0) throw new Error('cannot find the end of WORKBENCH_LOOP_RULES array');
  const body = source.slice(start, end);
  const items = [];
  for (const raw of body.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('export') || line === '[') continue;
    // 数组元素以逗号结尾：先去掉分隔逗号再判断引号配对
    if (line.endsWith(',')) line = line.slice(0, -1).trim();
    const quote = line[0];
    if (quote !== "'" && quote !== '`' && quote !== '"') continue;
    if (!line.endsWith(quote) || line.length < 2) continue;
    let text = line.slice(1, -1);
    text = text.replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/\\\\/g, '\\');
    items.push(text);
  }
  return items;
}

/** 抽出 Rust 侧 loop_rules_section 的 format! 字面量（去掉 Rust 转义与 format 花括号）。 */
function readRustRules() {
  const source = readFileSync(RS_PATH, 'utf8');
  const fnStart = source.indexOf('fn loop_rules_section');
  if (fnStart < 0) throw new Error('loop_rules_section not found in workbench_api.rs');
  const headerPos = source.indexOf('"## Delivery workflow', fnStart);
  if (headerPos < 0) throw new Error('contract header text not found in loop_rules_section');
  // 函数体内还有一个 `format!("ai00_plan_write …")`（plan_hint），取标题所在的那个 format!
  const rawStart = source.lastIndexOf('format!(', headerPos);
  const end = source.indexOf('\n    )', headerPos);
  if (rawStart < 0 || end < 0) throw new Error('cannot locate the format! body of loop_rules_section');
  let body = source.slice(rawStart + 'format!('.length, end);
  // 先按 Rust 源码行拼回（行尾 `\n\` 是续行），再解转义（顺序不能反：\\n 必须先于换行切分）
  body = body
    .split('\n')
    .map((line) => line.trim().replace(/\\$/, ''))
    .filter((line) => line.length > 0)
    .join('');
  body = body
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\{\{/g, '{')
    .replace(/\}\}/g, '}');
  // 源码续行标记（行尾 `\`）在拼回后残留：去掉"反斜杠 + 换行"
  body = body.replace(/\\\n/g, '\n');
  // 字面量首尾的引号
  body = body.replace(/^"/, '').replace(/"\s*$/, '');
  // {plan_hint} 是 format 变量，TS 侧对应 taskId 插值，比对前统一成占位符
  body = body.replace(/\{plan_hint\}/g, '__TASK_HINT__');
  return body;
}

/** 按编号项切分（1. 2. … 8.），返回 Map<编号, 文本>；首个无编号段记为 0。 */
function splitItems(text) {
  const map = new Map();
  const lines = text.split('\n');
  let current = 0;
  const buffer = [];
  const flush = () => {
    if (buffer.length) map.set(current, norm(buffer.join('\n')));
  };
  for (const line of lines) {
    const m = /^(\d+)\.\s/.exec(line.trim());
    if (m) {
      flush();
      buffer.length = 0;
      current = Number(m[1]);
    }
    if (line.trim()) buffer.push(line);
  }
  flush();
  return map;
}

const tsItems = splitItems(readTsRules().join('\n'));
const rsItems = splitItems(readRustRules());

const problems = [];
const numbers = [...new Set([...tsItems.keys(), ...rsItems.keys()])].sort((a, b) => a - b);
for (const n of numbers) {
  const ts = tsItems.get(n);
  const rs = rsItems.get(n);
  const label = n === 0 ? 'header' : `item ${n}`;
  if (!ts) {
    problems.push(`${label}: missing in promptParts.ts`);
    continue;
  }
  if (!rs) {
    problems.push(`${label}: missing in workbench_api.rs`);
    continue;
  }
  if (ts === rs) continue;
  // 找出首个差异位置，给一段可读的对照
  let i = 0;
  while (i < ts.length && i < rs.length && ts[i] === rs[i]) i += 1;
  problems.push(
    [
      `${label}: differs at char ${i}`,
      `  ts: …${ts.slice(Math.max(0, i - 60), i + 90)}`,
      `  rs: …${rs.slice(Math.max(0, i - 60), i + 90)}`,
    ].join('\n'),
  );
}

if (problems.length) {
  console.error('workbench loop contract drift detected:');
  console.error(problems.join('\n'));
  console.error(
    '\n两份规约必须逐条一致：改 promptParts.ts 的 WORKBENCH_LOOP_RULES 时同步 workbench_api.rs 的 loop_rules_section（反之亦然）。',
  );
  process.exit(1);
}

console.log(`workbench loop contract ok (${numbers.length} sections in sync)`);

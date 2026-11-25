/**
 * check-workbench-contract.mjs — 工作台规约两份副本的一致性门禁。
 *
 * 同一份口径有**两份物理副本**（改一处必须同步另一处）：
 *   ① web-ui 首条 prompt：`src/web-ui/src/agent/orchestrator/promptParts.ts`
 *      （`WORKBENCH_LOOP_RULES` 完整交付 / `QUICK_TASK_RULES` 快速问答）
 *   ② 宿主写进任务的 AGENTS.local.md：`src/apps/desktop/src/api/workbench_api.rs`
 *      （`loop_rules_section` / `quick_rules_section`）
 *
 * 实测两次漂移（Rust 副本整段缺了「Wrap-up 要跑集成验收」），而两份都各自"看起来对"，
 * 直到 agent 依 AGENTS 执行才发现。这里把两份规约都抓下来逐条比对：编号项必须逐字
 * 一致（空白/反引号/任务 id 插值归一后），任何差异打印出来并以 exit 1 结束。
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

/** 抽出 TS 侧某个导出常量（字符串数组）的元素。 */
function readTsArray(name) {
  const source = readFileSync(TS_PATH, 'utf8');
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in promptParts.ts`);
  const end = source.indexOf('].join(', start);
  if (end < 0) throw new Error(`cannot find the end of ${name} array`);
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
    // 2026-11-26 事故：单引号字符串里写了 `worker's`，没转义 → esbuild
    // 变换失败、主窗口只能看到 Vite 错误遮罩；而本门禁只比文本，照样通过。
    // 这里做一次引号完整性检查：去掉合法转义后，内容里不得再出现同类引号。
    const inner = line.slice(1, -1);
    if (quote !== '`') {
      const unescaped = inner.replace(/\\./g, '');
      if (unescaped.includes(quote)) {
        throw new Error(
          `${name}: unescaped ${quote} inside a ${quote}-quoted line — this breaks the TypeScript build:\n  ${line.slice(0, 160)}`,
        );
      }
    }
    let text = inner;
    text = text.replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/\\\\/g, '\\');
    items.push(text);
  }
  return items;
}

/** 抽出 Rust 侧某个规约函数里的字面量（去掉续行、Rust 转义与 format 花括号）。 */
function readRsLiteral(fnName, headerSnippet) {
  const source = readFileSync(RS_PATH, 'utf8');
  const fnStart = source.indexOf(`fn ${fnName}`);
  if (fnStart < 0) throw new Error(`${fnName} not found in workbench_api.rs`);
  const headerPos = source.indexOf(headerSnippet, fnStart);
  if (headerPos < 0) throw new Error(`contract header not found in ${fnName}`);
  // loop_rules_section 里还有一个 `format!("ai00_plan_write …")`（plan_hint），取标题所在的那个；
  // quick_rules_section 是裸字符串字面量（无 format!）。
  const fmtPos = source.lastIndexOf('format!(', headerPos);
  const bodyStart = fmtPos > fnStart ? fmtPos + 'format!('.length : headerPos;
  // 结尾：`format!` 以 `\n    )` 收口，裸字面量以 `\n        .to_string()` 收口——取先出现者
  const ends = [source.indexOf('\n    )', headerPos), source.indexOf('.to_string()', headerPos)]
    .filter((i) => i > bodyStart)
    .sort((a, b) => a - b);
  if (!ends.length) throw new Error(`cannot locate the end of ${fnName}`);
  const end = ends[0];
  let body = source.slice(bodyStart, end);
  // 先按 Rust 源码行拼回（行尾 `\` 是续行），再解转义（顺序不能反）
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

/** 比较一组副本，返回问题列表。split=true 时按编号项逐条比对，否则整段比对。 */
function compare({ label, tsText, rsText, split }) {
  const problems = [];
  const describe = (n) => (n === 0 ? `${label} header` : `${label} item ${n}`);
  if (!split) {
    const ts = norm(tsText);
    const rs = norm(rsText);
    if (ts === rs) return problems;
    let i = 0;
    while (i < ts.length && i < rs.length && ts[i] === rs[i]) i += 1;
    problems.push(
      [
        `${label}: differs at char ${i}`,
        `  ts: …${ts.slice(Math.max(0, i - 60), i + 90)}`,
        `  rs: …${rs.slice(Math.max(0, i - 60), i + 90)}`,
      ].join('\n'),
    );
    return problems;
  }
  const tsItems = splitItems(tsText);
  const rsItems = splitItems(rsText);
  const numbers = [...new Set([...tsItems.keys(), ...rsItems.keys()])].sort((a, b) => a - b);
  for (const n of numbers) {
    const ts = tsItems.get(n);
    const rs = rsItems.get(n);
    if (!ts) {
      problems.push(`${describe(n)}: missing in promptParts.ts`);
      continue;
    }
    if (!rs) {
      problems.push(`${describe(n)}: missing in workbench_api.rs`);
      continue;
    }
    if (ts === rs) continue;
    let i = 0;
    while (i < ts.length && i < rs.length && ts[i] === rs[i]) i += 1;
    problems.push(
      [
        `${describe(n)}: differs at char ${i}`,
        `  ts: …${ts.slice(Math.max(0, i - 60), i + 90)}`,
        `  rs: …${rs.slice(Math.max(0, i - 60), i + 90)}`,
      ].join('\n'),
    );
  }
  return problems;
}

const problems = [
  ...compare({
    label: 'delivery loop',
    tsText: readTsArray('WORKBENCH_LOOP_RULES').join('\n'),
    rsText: readRsLiteral('loop_rules_section', '"## Delivery workflow'),
    split: true,
  }),
  ...compare({
    label: 'quick answer',
    tsText: readTsArray('QUICK_TASK_RULES').join('\n'),
    rsText: readRsLiteral('quick_rules_section', '"## Quick answer mode'),
    split: false,
  }),
];

if (problems.length) {
  console.error('workbench contract drift detected:');
  console.error(problems.join('\n'));
  console.error(
    '\n两份规约必须一致：改 promptParts.ts 的 WORKBENCH_LOOP_RULES / QUICK_TASK_RULES 时同步 workbench_api.rs 的 loop_rules_section / quick_rules_section（反之亦然）。',
  );
  process.exit(1);
}

console.log('workbench contract ok (delivery loop + quick answer in sync)');

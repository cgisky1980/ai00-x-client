/**
 * prompts — todo 模块 AI 提示词单一收口（R1-5，2026-09-12）。
 *
 * web-ui 侧可调提示词统一存放，调提示词只改本文件：
 * - 委托任务书（useAgentDelegate 消费；R1-3 四段 = 目标/交付物/工具与资料/边界）
 * - 看门狗评估与恢复词（watchdog 消费；R1-2 支持带进度快照）
 * - 规划对话哨兵协议与 few-shot 文本（consult 消费）
 *
 * 收口边界（构建边界决定，见计划 R1-5 修正版）：
 * - dsh_manager.rs 的 orchestrator persona 走 cordis.patch "deployment:persona"
 *   槽（Rust 侧留守，槽只能整体覆盖不能追加）；
 * - dsh-plugins/tools/src/index.js 是独立插件包（独立 npm 构建，无法 import
 *   web-ui 模块），其 ai00_task_complete 验收拒绝文案留在原地——调验收口径时
 *   须与本文件「完工与收尾」段同步。
 */

// ===== 通用消息形状（consult 的 messages 模式） =====

export interface AiMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ===== 委托任务书（useAgentDelegate / assembleDelegationPrompt） =====

export const DELEGATE_RULES_HEADER = '【用户规则——必须遵守】';

export const DELEGATE_MEMORY_HEADER = '【用户记忆——供参考】';

export const DELEGATE_BOOK_TITLE = '════ 任务书 ════';

export const DELEGATE_COMPLETION_TITLE = '════ 完工与收尾 ════';

/** 交付物缺省口径（计划未写明时；四段「交付物」必填的兜底值）。 */
export const DELEGATE_DELIVERABLE_DEFAULT =
  '至少产出一份总结文件（如 report.md）——纯调研/咨询任务也必须有汇报产物；计划文档已写明时以其「## 交付物」段为准。';

/** 执行协议（编排者保留职责；收进「工具与资料」段）。 */
export const DELEGATE_PROTOCOL_ORCHESTRATION = (taskId: string): string =>
  `- 执行协议（编排者——你不亲自执行）：第一步先 ai00_plan_read（taskId: "${taskId}"）读取任务书全文，把「## 步骤」拆解为可派发的子任务；调研/查证类派 research_worker，实现/执行类派 code_worker，相互独立的子任务在同一条回复里并发派发。派发的每个任务写明：目标与验收标准、边界、相关文件与上下文线索、期望的返回格式（worker 看不到你们的对话，任务书必须自包含）。`;

/** 子代理完成通知处理（有计划文档时注入）。 */
export const DELEGATE_SUBAGENT_NOTIFY =
  '- 子代理完成通知：立即验收其结论，把「## 步骤」段对应项改为 "- [x]"（ai00_plan_write 全量写回），并把结果要点与遗留风险记录进计划文档；不合格就重新派发并说明问题。';

/** 长耗时操作预告（有计划文档时注入）。 */
export const DELEGATE_LONG_OP_NOTICE =
  '- 长耗时操作（编译/训练/下载等，预计超过 2 分钟）：收到子代理开始通知后先向用户发一句预计耗时（如「预计 20 分钟」），完成后再继续——策窗口按此安排检查节奏。';

/** 后台命令引导（有计划文档时注入；策执行流程审视 §2.6 的任务书引导）。 */
export const DELEGATE_BG_COMMAND_NOTICE =
  '- 长耗时命令：派发执行类任务时在任务书中提醒 worker：预计超过 2 分钟的命令用 pwsh 的 run_in_background: true 参数转后台执行——立即返回任务 id，完成后引擎会自动通知，用 job_output 读取输出再继续；不要让长命令阻塞在前台。';

/** 边界一：计划优先铁律（有计划文档时注入）。 */
export const DELEGATE_BOUNDARY_PLAN_FIRST =
  '- 计划优先（铁律）：用户执行期间发来的消息，若涉及需求、方案、步骤或验收标准的变化，必须先把变更落入计划文档（ai00_plan_read → ai00_plan_write 更新「## 步骤」/「## 验收」等），再按更新后的计划重新派发——以计划文档为唯一依据；若只是确认、催促等无需改计划的交流，直接简短回应即可。你自己发现方案需要变化时同此规：先改计划，再派发。';

/** 边界二：新想法落想法池、不私自扩范围。 */
export const DELEGATE_BOUNDARY_IDEA_POOL = (taskId: string): string =>
  `- 执行中发现需要新的子任务或想法，用 ai00_task_create 落入想法池（可带 sourceTaskId: "${taskId}" 标注来源、goalId 归志）——不要塞进当前计划文档的步骤段，也不要私自扩大执行范围。`;

/** 完工三步（收尾段；与 dsh-plugins/tools 验收拒绝文案口径同步）。 */
export const DELEGATE_COMPLETION_THREE_STEP = (taskId: string, cwd: string | null): string =>
  `全部子代理完成、验收项逐项确认后（人工判据在计划文档中勾选 "- [x]"），按「完工三步」收尾：① 把交付物写成真实文件——计划「交付物」段承诺的产物必须逐一落地为工作目录下的实际文件（缺失的先让子代理补齐），纯调研/咨询任务也必须产出一份总结文件（如 report.md）；② 调用 ai00_task_complete 提交自检（taskId: "${taskId}"${cwd ? `，snapshotDir: "${cwd}"——提交时自动 git 快照工作目录的全部改动，不要手动 commit` : ''}），并带上 deliverables 参数（产物的绝对路径清单，必填）；验收未全勾该工具会拒绝；③ 提交后在会话内向用户汇报：结论摘要（≤200字）+ 产物清单（文件名 + 一句话内容）+ 待验收提示。提交后任务进入人类验收：完成状态的认定以用户在策窗口的验收为准，但结果汇报与产物清单必须主动给出，不要等用户来要。`;

// ===== 看门狗（watchdog） =====

/** 评估 agent 的角色行。 */
export const STALL_JUDGE_SYSTEM = '你是 agent 执行监督员，只输出严格 JSON。';

/** 评估 prompt 文本（judgeStall 消费；tailDesc 由调用方折叠事件流水账得出）。 */
export function buildStallJudgePrompt(opts: {
  title: string;
  idleMinutes: number;
  currentStep?: string | null;
  tailDesc: string;
}): string {
  return [
    `一个 AI agent 正在执行任务「${opts.title}」，已 ${opts.idleMinutes} 分钟没有任何新事件（无新 token、无工具返回——说明当前操作没有可观察的输出流）。`,
    opts.currentStep ? `当前计划步骤：${opts.currentStep}` : '',
    '最近的执行记录：',
    opts.tailDesc,
    '',
    '注意：模型训练、程序编译等操作可能合法运行数小时，不要仅因静默时间长就判卡死。',
    '请结合操作类型判断这是【正常的长耗时操作】还是【卡死/异常】（死循环、弹窗阻塞、进程挂起等）。',
    '只输出 JSON：',
    '正常：{"verdict":"normal","etaMinutes":<预计还需的分钟数>,"reason":"一句话"}',
    '卡死：{"verdict":"stuck","reason":"一句话依据"}',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 恢复词（R1-2：带进度快照——恢复从"靠赌"变"拿进度条续跑"）。
 * snapshot 缺失（历史拉不到/无计划文档）时回落"自己重读计划"旧口径。
 */
export function buildWatchdogRecoverPrompt(opts?: {
  snapshot?: string;
  judgeReason?: string;
}): string {
  const lines = ['【自动恢复】检测到执行长时间无响应，已中断卡住的轮次。'];
  if (opts?.snapshot) lines.push(opts.snapshot);
  if (opts?.judgeReason) lines.push(`（检测依据：${opts.judgeReason}）`);
  lines.push(
    opts?.snapshot
      ? '请对照上方进度快照从断点继续执行：已完成项不要重做，未完成的子任务请重新派发（research_worker/code_worker），不要亲自调用执行工具；快照与计划文档不一致时，先用 ai00_plan_read 重读计划文档确认进度。'
      : '请先用 ai00_plan_read 重读计划文档确认当前进度，然后从断点继续执行；未完成的子任务请重新派发（research_worker/code_worker），不要亲自调用执行工具。',
  );
  return lines.join('\n');
}

// ===== 规划对话哨兵协议与 few-shot（consult） =====

/** 快思考预填（官方 G1 格式：<think> + 换行 + </think>）。生成从 </think> 后立即开始。 */
export const THINK_PREFILL: AiMsg = { role: 'assistant', content: '<think>\n</think>\n```json' };

/**
 * 围栏收尾停止序列：替代引擎默认组。返回文本 = ```json 围栏内的一份 JSON，
 * 遇闭合围栏立即截断；同时保留角色标记兜底（防围栏缺失时无限续写）。
 */
export const FENCE_STOPS: string[] = [
  '\n```',
  '\n\nUser:',
  '\n\nSystem:',
  '\n\nInstruction:',
  '\n\nInput:',
  '\n\nAssistant:',
];

/** 只读三件套协议行（仅已绑定工作区的讨论轮注入）。 */
export const TOOL_PROTOCOL_LINE =
  '\n三、需要实际查看项目文件再定稿时，可调用只读工具（系统执行后把结果提供给你，再按一/二/三继续）：' +
  '{"tool":"read_file","path":"相对工作区的文件路径"} 读文件内容；' +
  '{"tool":"list_dir","path":"相对工作区的目录路径"} 列目录（省略 path 列根目录）；' +
  '{"tool":"search","query":"关键词"} 在工作区内全文搜索。';

/** 计划契约 schema（出计划/编辑计划共用）。 */
export const PLAN_SCHEMA =
  '{"summary":"一段话摘要","goal":"一句话目标","tasks":[{"title":"步骤名","notes":"补充"}],"acceptance":["验收1","验收2"],"deliverable":"交付物描述"}';

// —— 计划编辑器模式（专用修改格式，用户定稿 2026-08-28）——

export const buildPlanEditProtocol = (planHint?: string): string =>
  `你是计划编辑器。根据用户的修改意见更新给定的计划 JSON。回复协议：只输出更新后的完整计划 JSON（用 \`\`\`json 围栏包裹），schema：${PLAN_SCHEMA}。用户没有提到的部分原样保留；tasks 每一项必须是含 title 键的对象，绝不能是字符串数组；acceptance 给3-6项可客观检验的判据；deliverable 必填且具体——写明可交付的产物文件名与内容形式（如 "report.md 调研报告"、"报销明细.md + 发票扫描件.zip"），即使纯咨询/调研类任务也必须产出一份汇报文件。` +
  (planHint ? `\n额外要求：${planHint}` : '');

export const PLAN_EDIT_DEMO: AiMsg[] = [
  {
    role: 'assistant',
    content:
      '```json\n{"summary":"汇总本季报销票据并当面提交财务","goal":"周五前完成报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"周五当面提交给财务","notes":"替代原电话跟进"}],"acceptance":["金额与票据一致","周五完成当面提交"],"deliverable":"报销明细.md 提交清单"}\n```',
  },
  {
    role: 'user',
    content:
      '当前计划：{"summary":"汇总本季报销票据并提交财务系统","goal":"周五前完成报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"跟进部门审批","notes":"周五前完成"}],"acceptance":["金额与票据一致","系统状态为已提交"],"deliverable":"季度报销单"}\n修改意见：第三步审批不用了，改成周五当面提交给财务。其他都不变。',
  },
  {
    role: 'assistant',
    content:
      '```json\n{"summary":"汇总本季报销票据并当面提交财务","goal":"周五前完成报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"周五当面提交给财务","notes":""}],"acceptance":["金额与票据一致","周五完成当面提交"],"deliverable":"报销明细.md 提交清单"}\n```',
  },
];

// —— 出计划模式（从零创建）——

export const buildPlanCreateProtocol = (planHint?: string): string =>
  `你是规划助手，根据需求和讨论拟定计划契约。回复协议：只输出一个 JSON（用 \`\`\`json 围栏包裹）：${PLAN_SCHEMA}。tasks 给3-7个按推进顺序，每一项必须是含 title 键的对象（如 {"title":"步骤名"}），绝不能是字符串数组；acceptance 是可客观检验的完成判据，给3-6项；deliverable 必填且具体——写明可交付的产物文件名与内容形式（如 "report.md 调研报告"、"summary.md 总结"），即使纯咨询/调研类任务也必须产出一份汇报文件；只依据材料里的信息。所有字段必须填与需求相关的具体内容，禁止照抄示例占位词（如"步骤名""补充""验收1"）；title 不要带 [in_progress]/[pending] 等状态标记；回复的第一个字符必须是 { ，最后一个字符必须是 } 。` +
  (planHint ? `\n额外要求：${planHint}` : '');

export const PLAN_CREATE_DEMO: AiMsg = {
  role: 'assistant',
  content:
    '```json\n{"summary":"汇总本季报销票据并提交财务系统","goal":"完成本季度报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"跟进部门审批","notes":""}],"acceptance":["金额与票据一致","系统状态为已提交"],"deliverable":"报销明细.md 提交清单"}\n```',
};

// —— 计划接地模式（讨论轮 + 已有计划）——

export const buildPlanGroundedProtocol = (hasWorkspace?: boolean): string =>
  '你是规划助手，卡片已有一份计划（材料中给出）。与用户讨论这份计划的调整，你拥有工具 create_plan（更新计划文件）。回复协议：只输出一个 JSON（用 ```json 围栏包裹），按情形回复：\n' +
  '一、用户的调整意向不明确，先追问：{"reply":"简短回应","questions":[{"q":"关键问题","options":["选项1","选项2"],"allowInput":true}]}。questions 最多2个问题，每个配2-4个候选项。\n' +
  '二、用户给出了明确的调整（或认可现状），调用工具：{"tool":"create_plan"}。只输出这个 JSON，不要附加计划内容，系统会按讨论结论更新计划文件。' +
  (hasWorkspace ? TOOL_PROTOCOL_LINE : '');

export const PLAN_GROUNDED_DEMO: AiMsg[] = [
  {
    role: 'assistant',
    content:
      '```json\n{"reply":"好的，确认一下第三步想怎么调。","questions":[{"q":"第三步想怎么调整","options":["换成轻松的活动","时间往后挪","直接删掉"],"allowInput":true}]}\n```',
  },
  {
    role: 'user',
    content:
      '当前计划（讨论以此为准）：\n目标：周末前完成报销提交\n摘要：整理发票并提交财务系统\n步骤：1. 核对三张发票金额；2. 录入财务系统；3. 跟进部门审批\n验收：金额与票据一致；系统状态为已提交\n\n用户：嗯第三步太赶了，把审批挪到下周吧，其他都不变，直接改。',
  },
  { role: 'assistant', content: '```json\n{"tool":"create_plan"}\n```' },
];

// —— 需求澄清模式（讨论轮 + 无计划）——

export const buildPlanClarifyProtocol = (hasWorkspace?: boolean): string =>
  '你是规划助手，与用户讨论需求，你拥有工具 create_plan（创建计划文件）。回复协议：只输出一个 JSON（用 ```json 围栏包裹），按情形回复：\n' +
  '一、信息不足，先追问：{"reply":"简短回应","questions":[{"q":"关键问题","options":["选项1","选项2"],"allowInput":true}]}。questions 最多2个问题，每个配2-4个候选项。\n' +
  '二、信息足够（时间/数量/方式等关键信息已明确，或用户已表示无需追问），调用工具：{"tool":"create_plan"}。只输出这个 JSON，不要附加计划内容，系统会自动生成计划文件。' +
  (hasWorkspace ? TOOL_PROTOCOL_LINE : '');

export const PLAN_CLARIFY_DEMO: AiMsg[] = [
  {
    role: 'assistant',
    content:
      '```json\n{"reply":"好的，先确认发票状态。","questions":[{"q":"发票现在的情况","options":["都已收齐","还差几张","还没整理"],"allowInput":true}]}\n```',
  },
  { role: 'user', content: '需求：整理报销发票。情况我还没梳理，回头看看再说。' },
  {
    role: 'assistant',
    content:
      '```json\n{"reply":"好的，不着急。","questions":[{"q":"大概什么时候要提交","options":["本周内","月底前","还没定"],"allowInput":true},{"q":"大概几张发票","options":["三五张","十张左右","不确定"],"allowInput":false}]}\n```',
  },
];

/** 用户交权话术：命中说明用户已放弃「被追问」，可提示模型调用工具。 */
export const DELEGATION_RE = /不用问|别问了|直接安排|你安排|你来安排|你决定|直接拟|开始吧|可以了|就这样/;

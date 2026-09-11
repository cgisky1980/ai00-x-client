// ========================================================================
// 剧场文案池（气泡 emoji / 分类关键词 / 剧场台词池）
// ========================================================================
// 文案规范（设计 §3.3）：气泡只出现在 trouble/thinking/milestone/deliver
// 四类状态，其余时刻零气泡；卡片标签等 UI 字符串走 i18n
// （locales/*/agentTheater.json）。本文件放语言无关部分（emoji/关键词）
// 与工灵实时台词池（中文——工灵定位中文剧场人格，沿 TOOL_ACTION_LABELS
// 中文先例；英文 UI 由 i18n 状态文案兜底覆盖，见 AgentImp）。

/** 各状态的气泡 emoji 池（展示时随机取一） */
export const BUBBLE_EMOJI: Record<'trouble' | 'thinking' | 'milestone' | 'deliver-big' | 'deliver-quiet', string[]> = {
  trouble: ['😵', '💥', '🫠'],
  thinking: ['💤', '💭'],
  milestone: ['✨', '⚡', '🎯'],
  'deliver-big': ['🎉', '🌟', '🚀'],
  'deliver-quiet': ['😮‍💨', '🧹'],
};

/** appear 阶段气泡（开工） */
export const APPEAR_EMOJI = ['💪', '🔧', '📋'];

/**
 * 工灵实时台词池（剧场设定 2026-09-11）：按 phase 出池，以 sessionId+phase
 * 哈希稳定选取——同一会话同一状态不跳动，重启形象与台词一致。
 * working 无工具动作时的兜底台词也在此。
 */
export const THEATER_LINES: Record<
  'appear' | 'working' | 'thinking' | 'trouble' | 'milestone' | 'deliver-big' | 'deliver-quiet' | 'acceptance',
  string[]
> = {
  appear: ['开场锣响，登场！', '幕布拉开，开工', '锣鼓一响，活儿登场'],
  working: ['紧锣密鼓赶活中', '台上翻腾，一招一式', '埋头赶路，招式不停'],
  thinking: ['后台踱步，琢磨剧本', '闭目酝酿下一幕', '台后沉思，酝酿大招'],
  trouble: ['台词卡壳了！', '一招落空，踉跄半步', '台上出岔，急中生智'],
  milestone: ['一幕顺利落幕！', '漂亮一记满堂彩', '此幕告捷，乘胜追击'],
  'deliver-big': ['大幕落下，满堂喝彩！', '功德圆满，谢礼四方', '好戏收官，交付满堂'],
  'deliver-quiet': ['鞠躬谢幕，悄然收场', '收好行头，落幕下台'],
  acceptance: ['候场待定，请导演审片', '行头已备，候您验看'],
};

/** 分类器关键词表（小写匹配；含中英双语） */
export const CATEGORY_KEYWORDS: ReadonlyArray<{
  category: 'coding' | 'debugging' | 'research' | 'writing';
  patterns: string[];
}> = [
  {
    category: 'debugging',
    patterns: ['debug', 'fix', 'bug', 'error', 'fail', '修复', '调试', '报错', '排查'],
  },
  {
    category: 'research',
    patterns: ['search', 'research', '查找', '调研', '搜索', '资料', '为什么', '是什么'],
  },
  {
    category: 'writing',
    patterns: ['doc', 'readme', 'markdown', '文档', '说明', '写一篇', '总结'],
  },
  {
    category: 'coding',
    patterns: ['implement', 'refactor', 'add', 'feature', 'test', '实现', '重构', '新增', '功能', '编码', '开发'],
  },
];

/** 研究类工具集（分类器在无关键词时按工具构成兜底） */
export const RESEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'LS']);

/** 工具名 → 人话动作（工灵 tooltip 用；未识别的工具显示原名） */
export const TOOL_ACTION_LABELS: Record<string, string> = {
  Read: '读文件',
  LS: '列目录',
  Glob: '找文件',
  Grep: '搜索',
  Bash: '运行命令',
  Edit: '编辑文件',
  Multiedit: '编辑文件',
  Write: '写入文件',
  NotebookEdit: '编辑文件',
  TodoWrite: '更新计划',
  WebSearch: '检索',
  WebFetch: '检索',
  Task: '派出子代理',
  ComputerUse: '操作桌面',
};

/**
 * 从池中稳定选取一项：以 sessionId+phase 哈希选——同一会话同一状态
 * 不随渲染跳动（AgentImp 的 pickEmoji 通用化，台词/emoji 共用）。
 */
export function pickFrom(pool: string[], sessionId: string, phase: string): string {
  let h = 0;
  const key = `${sessionId}:${phase}`;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}

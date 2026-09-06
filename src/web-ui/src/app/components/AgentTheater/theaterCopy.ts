// ========================================================================
// 剧场文案池（气泡 emoji 与分类关键词；纯 emoji 语言无关）
// ========================================================================
// 文案规范（设计 §3.3）：气泡只出现在 trouble/thinking/milestone/deliver
// 四类状态，其余时刻零气泡；卡片标签等用户可见字符串走 i18n
// （locales/*/agentTheater.json），本文件只放语言无关的部分。

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

/** 工具名 → 人话动作（工灵实时标签用；未识别的工具显示原名） */
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

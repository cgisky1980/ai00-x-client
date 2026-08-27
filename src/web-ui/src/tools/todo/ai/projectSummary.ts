/**
 * projectSummary — 志·AI 评估的项目实况采集。
 *
 * 绑定项目目录的志，评估前采集三样：两层目录树（忽略依赖/构建产物）、
 * README 头部、最近 git 提交——拼成文本喂给评估模型，让评估基于
 * 项目真实状态而非凭空臆测。采集失败的部分静默跳过（尽力而为）。
 */
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { gitAPI } from '@/infrastructure/api/service-api/GitAPI';
import type { ExplorerNodeDto } from '@/infrastructure/api/service-api/tauri-commands';

/** 忽略的目录（依赖/构建产物/版本库——体积大且无评估价值）。 */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next', 'out', '.venv', '__pycache__']);

/** 树渲染：每层最多 maxPerLayer 项，超出的以 … 概括。 */
function renderTree(nodes: ExplorerNodeDto[], depth: number, maxPerLayer: number): string[] {
  const lines: string[] = [];
  const visible = nodes.filter(n => !IGNORED_DIRS.has(n.name) && !n.name.startsWith('.'));
  const shown = visible.slice(0, maxPerLayer);
  for (const n of shown) {
    lines.push(`${'  '.repeat(depth)}${n.isDirectory ? `${n.name}/` : n.name}`);
    if (n.isDirectory && n.children?.length && depth < 1) {
      lines.push(...renderTree(n.children, depth + 1, maxPerLayer));
    }
  }
  if (visible.length > shown.length) {
    lines.push(`${'  '.repeat(depth)}…（另有 ${visible.length - shown.length} 项）`);
  }
  return lines;
}

/** 采集项目实况摘要；目录不可读返回 null（调用方退化纯愿景评估）。 */
export async function collectProjectSummary(dir: string): Promise<string | null> {
  const sections: string[] = [];

  // 1. 目录树（两层；getFileTree 失败即视为不可读）
  const tree = await workspaceAPI.getFileTree(dir, 2).catch(() => null);
  if (!tree?.length) return null;
  const treeLines = renderTree(tree, 0, 20);
  if (treeLines.length) sections.push(`目录结构：\n${treeLines.join('\n')}`);

  // 2. README 头部（多种命名尝试）
  for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
    const content = await workspaceAPI.readFileContent(`${dir.replace(/[\\/]$/, '')}/${name}`).catch(() => null);
    if (content && content.trim()) {
      sections.push(`README 头部：\n${content.trim().slice(0, 1500)}`);
      break;
    }
  }

  // 3. 最近 git 提交（非仓库静默跳过）
  const commits = await gitAPI.getCommits(dir, { maxCount: 10 }).catch(() => null);
  if (commits?.length) {
    const lines = commits.slice(0, 10).map(c => `- ${c.message.split('\n')[0]}`);
    sections.push(`最近 git 提交：\n${lines.join('\n')}`);
  }

  return sections.length ? sections.join('\n\n') : null;
}

/**
 * dsh agent 运行环境版本常量（唯一来源：packages/shared/agent-versions.json）
 *
 * 由 `scripts/generate-agent-versions.cjs` 自动生成。禁止手动修改本文件；
 * 修改版本请编辑 JSON 源文件后运行 `pnpm run generate-agent-versions`。
 */

/** dsh 0.1.x 要求 ^22.19 || >=24；选 24 LTS 官方 CI 主力线 */
export const AGENT_NODE_VERSION = '24.20.0';

/** 钉死的 dsh npm 版本（锁版本升级走受控机制） */
export const AGENT_DSH_NPM_SPEC = '@deepseek-ai/dsh@0.1.5-rc.2';

/** dsh NPM 镜像（国内加速） */
export const AGENT_NPM_REGISTRY = 'https://registry.npmmirror.com';

/** 随客户端分发的 dsh 插件清单：(目录名, npm 包名)。 */
export const AGENT_BUNDLED_PLUGINS: ReadonlyArray<{ dir: string; npmName: string }> = [
  { dir: 'ai-bridge', npmName: '@ai00-x/dsh-ai-bridge' },
  { dir: 'tools', npmName: '@ai00-x/dsh-tools' },
];

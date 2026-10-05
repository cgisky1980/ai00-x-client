#!/usr/bin/env node
/**
 * dsh-upgrade-check.mjs — dsh 引擎升级触点验证（人工核对清单的自动化）
 *
 * 对目标版本下载 tgz → 解包 → 逐项检查我方全部耦合触点，输出绿/红报告：
 *   全绿 → 可走快速通道（bump agent-versions.json → generate → 沙箱 dump-config
 *          + 双插件门禁 → exe，约 1 小时）
 *   有红 → 仅红项需人工聚焦（对照 agent-host/patches/<当前版本>/INTENT.md）
 *
 * 检查清单来源：2026-10-01 0.1.5→0.2.0 升级时人工验证的耦合面（已实测方法）。
 * 注意：主包 tgz 只含自身，触点子包按 manifest.dependencies 逐个下载检查。
 * 用法：node scripts/dsh-upgrade-check.mjs <version> [--registry URL]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_MIRROR = 'https://registry.npmmirror.com';
const args = process.argv.slice(2);
const registryIdx = args.indexOf('--registry');
const REGISTRY = registryIdx !== -1 ? args[registryIdx + 1] : NPM_MIRROR;
const TARGET = args.find((a) => !a.startsWith('--'));

if (!TARGET || !/^\d+\.\d+\.\d+/.test(TARGET)) {
  console.error('usage: node scripts/dsh-upgrade-check.mjs <version> [--registry URL]');
  process.exit(2);
}

const PKG = '@deepseek-ai/dsh';

/** 我方 patch/链路触点的官方包（agent-host patches 引用的行 name） */
const REQUIRED_PACKAGES = [
  'dsh-base',
  'dsh-web-app',
  'dsh-tool-subagent',
  'dsh-hooks-claude-code',
  'dsh-mcp-client',
  'dsh-skill-filesystem',
];

/** 检查用但不要求主包 dependencies 声明的包（按需加载/传递依赖；独立 tgz 存在即可） */
const OPTIONAL_PACKAGES = ['dsh-settings', 'dsh-agent-preset', 'dsh-client-connection'];

const CHECKS = [
  {
    id: 'auth.token-line',
    pkg: 'dsh-web-app|dsh-client-connection',
    patterns: ['?token='],
    desc: 'stdout 一次性鉴权 token 行（dsh_manager 行泵解析依赖）',
  },
  {
    id: 'cli.no-open',
    pkg: 'dsh-web-app',
    patterns: ['no-open'],
    desc: 'CLI --no-open 参数（spawn 命令依赖）',
  },
  {
    id: 'cli.trusted-host',
    pkg: 'dsh-web-app',
    patterns: ['trusted-host', 'trustedHosts'],
    desc: 'CLI --trusted-host / trust fence（2100 反代放行依赖）',
  },
  {
    id: 'cli.profile-flag',
    pkg: '__cli__',
    patterns: ['--profile'],
    desc: '顶层 --profile 形式（0.2.0 起 web 为 shipped profile）',
  },
  {
    id: 'cli.dump-config',
    pkg: '__cli__',
    patterns: ['dump-config'],
    desc: '--dump-config（patch 装配验证工具链）',
  },
  {
    id: 'cli.plugin-subcmd',
    pkg: '__cli__',
    patterns: ['plugin'],
    desc: 'dsh plugin 子命令（预装插件安装链）',
  },
  {
    id: 'subagent.spawn-config',
    pkg: 'dsh-tool-subagent',
    patterns: ['spawn', 'agentOptions'],
    desc: 'worker 行的 provider: spawn + agentOptions 配置键',
  },
  {
    id: 'skill.bundled-dir',
    pkg: 'dsh-skill-filesystem',
    patterns: ['bundledSkillDir'],
    desc: 'bundledSkillDir 覆写行配置键（内置技能挂载）',
  },
  {
    id: 'persona.slot',
    pkg: 'dsh-agent-preset',
    patterns: ['persona', 'deployment'],
    desc: 'persona/deployment 槽概念（编排 patch 覆写 system-prompt 的前提）',
  },
  {
    id: 'settings.yaml',
    pkg: 'dsh-settings',
    patterns: ['settings.yaml'],
    desc: 'settings.yaml 机制（默认模型迁移写入）',
  },
  {
    id: 'mcp.client-config',
    pkg: 'dsh-mcp-client',
    patterns: ['stdio', 'streamable-http'],
    desc: 'mcp-client 传输配置键（0.2.0 起 serverName 必须配 command/url）',
  },
];

function sh(cmd, argsList, cwd) {
  return execFileSync(cmd, argsList, {
    encoding: 'utf8',
    cwd,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 下载单个 tgz 并解包到 destDir（镜像替换 + GNU tar 的 "C:" 主机名坑规避） */
async function fetchTarball(pkgName, version, destDir) {
  const encName = encodeURIComponent(pkgName);
  const metaResp = await fetch(`${REGISTRY}/${encName}/${version}`);
  if (!metaResp.ok) throw new Error(`${pkgName} manifest http ${metaResp.status}`);
  const meta = await metaResp.json();
  const tarball = meta.dist?.tarball;
  if (!tarball) throw new Error(`${pkgName} manifest has no tarball url`);
  const mirrored = tarball.replace('registry.npmjs.org', 'registry.npmmirror.com');
  const tgzResp = await fetch(mirrored, { signal: AbortSignal.timeout(120_000) });
  if (!tgzResp.ok) throw new Error(`${pkgName} tarball http ${tgzResp.status}`);
  const buf = Buffer.from(await tgzResp.arrayBuffer());
  fs.mkdirSync(destDir, { recursive: true });
  const tgzPath = path.join(destDir, 'pkg.tgz');
  fs.writeFileSync(tgzPath, buf);
  const posix = tgzPath.split('\\').join('/');
  const posixDir = destDir.split('\\').join('/');
  sh('tar', ['--force-local', '-xzf', posix, '-C', posixDir]);
  return path.join(destDir, 'package');
}

async function downloadAll(version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-check-'));
  // 主包（CLI 检查用）
  const cliDir = await fetchTarball(PKG, version, path.join(tmp, 'main'));
  // 触点子包：按主包 manifest.dependencies 的 spec 逐个下载
  const enc = encodeURIComponent(PKG);
  const metaResp = await fetch(`${REGISTRY}/${enc}/${version}`);
  if (!metaResp.ok) throw new Error(`registry manifest http ${metaResp.status}`);
  const meta = await metaResp.json();
  const deps = meta.dependencies ?? {};
  const pkgDirs = {};
  for (const name of [...REQUIRED_PACKAGES, ...OPTIONAL_PACKAGES]) {
    const fullName = `@deepseek-ai/${name}`;
    // 依赖声明与否不重要——直接按目标版本下载独立 tgz（按需加载包不在
    // 主包 dependencies 里，但 tgz 存在即引擎可解析）
    try {
      pkgDirs[name] = await fetchTarball(fullName, version, path.join(tmp, 'pkgs', name));
    } catch (e) {
      pkgDirs[name] = null;
      void e;
    }
  }
  return { tmp, cliDir, pkgDirs };
}

function grepCount(dir, pattern) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        stack.push(full);
      } else if (/\.(js|mjs|cjs|json|md)$/.test(e.name)) {
        try {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes(pattern)) count++;
        } catch {
          /* 跳过大文件/二进制 */
        }
      }
    }
  }
  return count;
}

async function main() {
  console.log(`=== dsh 升级触点验证：${PKG}@${TARGET} ===`);
  const { tmp, cliDir, pkgDirs } = await downloadAll(TARGET);
  const results = [];

  // A. 触点包存在性（在主包 dependencies 中声明 = 引擎 boot 可解析）
  console.log('\n--- A. 触点包存在性 ---');
  for (const name of REQUIRED_PACKAGES) {
    const dir = pkgDirs[name];
    results.push({
      id: `pkg.${name}`,
      ok: !!dir,
      note: dir ? 'present' : 'MISSING（主包 dependencies 未声明，patch 行将无法解析）',
    });
    console.log(`  ${dir ? '✓' : '✗'} @deepseek-ai/${name}`);
  }

  // B. 耦合触点检查
  console.log('\n--- B. 耦合触点检查 ---');
  for (const check of CHECKS) {
    let ok = false;
    let note = '';
    if (check.pkg === '__cli__') {
      const bin = path.join(cliDir, 'lib', 'bin.js');
      if (!fs.existsSync(bin)) {
        note = 'lib/bin.js 不存在（CLI 结构变化？）';
      } else {
        const text = fs.readFileSync(bin, 'utf8');
        ok = check.patterns.every((p) => text.includes(p));
        note = check.patterns.map((p) => `${p}:${text.includes(p) ? 'ok' : 'MISSING'}`).join(' ');
      }
    } else {
      // "a|b" 形式：任一包命中即通过（同一能力可能随版本迁移实现位置）
      const dirNames = check.pkg.split('|');
      let best = null;
      for (const name of dirNames) {
        const dir = pkgDirs[name];
        if (!dir) continue;
        const counts = check.patterns.map((p) => ({ p, n: grepCount(dir, p) }));
        if (counts.every((c) => c.n > 0)) {
          ok = true;
          best = `${name}: ${counts.map((c) => `${c.p}×${c.n}`).join(' ')}`;
          break;
        }
        if (best === null) best = `${name}: ${counts.map((c) => `${c.p}×${c.n}`).join(' ')}`;
      }
      note = ok ? best : (best ?? '包缺失，无法检查');
    }
    results.push({ id: check.id, ok, note });
    console.log(`  ${ok ? '✓' : '✗'} ${check.id} — ${check.desc}`);
    console.log(`      ${note}`);
  }

  // C. 汇总
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length === 0) {
    console.log('✓ 全绿——可走快速通道：');
    console.log(`  1. 编辑 packages/shared/agent-versions.json dshNpmSpec → @deepseek-ai/dsh@${TARGET}`);
    console.log('  2. pnpm run generate-agent-versions');
    console.log('  3. 沙箱 DSH_HOME dump-config 验证编排装配 + 双插件门禁');
    console.log('  4. cargo build --release -p ai00-x-desktop');
    console.log(`  5. 复制 agent-host/patches/<旧版本>/ → ${TARGET}/（行为无变化时仅改名）`);
  } else {
    console.log(`✗ ${failed.length} 项需人工聚焦：`);
    for (const f of failed) console.log(`  - ${f.id}: ${f.note}`);
    console.log('  对照 agent-host/patches/ 下当前版本 INTENT.md 的触点说明逐项核对。');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('upgrade-check failed:', e);
  process.exit(2);
});

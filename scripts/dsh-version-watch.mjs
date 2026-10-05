#!/usr/bin/env node
/**
 * dsh-version-watch.mjs — dsh 引擎版本雷达
 *
 * 每日/升级前跑一次，报告：
 *   1. 我们钉的版本 vs 上游 latest/next/alpha（npmmirror）
 *   2. 主包 @deepseek-ai/* 运行时依赖清单 diff（拆包/新包一眼可见）
 *   3. dsh-desktop 前哨：他们 stable/beta 通道钉的版本（生产级背书信号）
 *   4. 建议动作（跟 / 观察 / 等前哨）
 *
 * 无参数、只读、零依赖（node 内置 fetch + npm view）。
 * 用法：node scripts/dsh-version-watch.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS_JSON = path.join(ROOT, 'packages', 'shared', 'agent-versions.json');
const NPM_MIRROR = 'https://registry.npmmirror.com';
const DSH_DESKTOP_UPSTREAM =
  'https://raw.githubusercontent.com/anywhere-labs/dsh-desktop/master/upstream.json';

function readPinned() {
  const src = JSON.parse(fs.readFileSync(VERSIONS_JSON, 'utf8'));
  return src.dshNpmSpec; // "@deepseek-ai/dsh@0.2.0-rc.2"
}

/** npmmirror registry API：dist-tags / manifest（零进程调用，纯 fetch） */
async function registryFetch(kind, version = '') {
  const name = encodeURIComponent('@deepseek-ai/dsh'); // @scope/name → @scope%2Fname
  const url =
    kind === 'dist-tags'
      ? `${NPM_MIRROR}/-/package/${name}/dist-tags`
      : `${NPM_MIRROR}/${name}/${version}`;
  return fetchJson(url, 20_000);
}

async function fetchJson(url, timeoutMs = 15_000) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { __error: `http ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { __error: String(e).slice(0, 200) };
  }
}

/** 版本比较（0.x 预发布语义简版：数字段逐位比，pre 标签字母序） */
function cmpVersion(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) return null;
    return {
      core: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? null,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  // 无 pre > 有 pre
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return String(pa.pre).localeCompare(String(pb.pre));
}

async function deepseekDeps(version) {
  const info = await registryFetch('manifest', version);
  if (info.__error) return { __error: info.__error };
  return Object.keys(info.dependencies ?? {})
    .filter((k) => k.startsWith('@deepseek-ai/'))
    .sort();
}

function diffLists(oldList, newList) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  return {
    added: newList.filter((x) => !oldSet.has(x)),
    removed: oldList.filter((x) => !newSet.has(x)),
  };
}

async function main() {
  const pinnedSpec = readPinned();
  const pinned = pinnedSpec.split('@').pop();
  console.log('=== dsh 版本雷达 ===');
  console.log(`我方钉版: ${pinnedSpec}`);

  // 1. dist-tags
  const tags = await registryFetch('dist-tags');
  if (tags.__error) {
    console.error(`✗ npmmirror dist-tags 查询失败: ${tags.__error}`);
    process.exit(2);
  }
  console.log(`上游 dist-tags: latest=${tags.latest} next=${tags.next ?? '-'} alpha=${tags.alpha ?? '-'}`);

  const ahead = {
    latest: cmpVersion(tags.latest, pinned),
    next: tags.next ? cmpVersion(tags.next, pinned) : -1,
  };
  if (ahead.latest <= 0 && (ahead.next ?? -1) <= 0) {
    console.log('✓ 已是最新（latest 与 next 均不高于钉版）');
  } else {
    console.log(`⚠ 有新版本: latest ${ahead.latest > 0 ? '领先' : '不高于'}钉版, next ${ahead.next > 0 ? '领先' : '不高于'}钉版`);
  }

  // 2. 主包依赖 diff（pinned vs latest）
  if (cmpVersion(tags.latest, pinned) > 0) {
    console.log(`\n--- 运行时依赖清单 diff（${pinned} → ${tags.latest}）---`);
    const oldDeps = await deepseekDeps(pinned);
    const newDeps = await deepseekDeps(tags.latest);
    if (oldDeps.__error || newDeps.__error) {
      console.log(`  依赖查询失败: ${oldDeps.__error ?? newDeps.__error}`);
    } else {
      const d = diffLists(oldDeps, newDeps);
      console.log(`  包数 ${oldDeps.length} → ${newDeps.length}`);
      if (d.added.length) console.log(`  新增: ${d.added.join(', ')}`);
      if (d.removed.length) console.log(`  移除: ${d.removed.join(', ')}`);
      if (!d.added.length && !d.removed.length) console.log('  无增删');
    }
  }

  // 3. dsh-desktop 前哨
  console.log('\n--- dsh-desktop 前哨（anywhere-labs）---');
  const upstream = await fetchJson(DSH_DESKTOP_UPSTREAM);
  if (upstream.__error) {
    console.log(`  查询失败: ${upstream.__error}（网络受限时忽略此项）`);
  } else {
    const stable = upstream.channels?.stable ?? {};
    const beta = upstream.channels?.beta ?? {};
    console.log(
      `  stable=${stable.sourceVersion ?? '?'}  beta=${beta.sourceVersion ?? '?'}  (activeChannel=${upstream.activeChannel ?? '?'})`,
    );
    const stableCmp = stable.sourceVersion ? cmpVersion(stable.sourceVersion, pinned) : -1;
    if (stableCmp >= 0) {
      console.log('  ✓ 前哨已跟进到 ≥ 我方钉版——升级风险窗口小，可安排跟进');
    } else {
      console.log('  · 前哨尚未跟进到最新——建议等前哨先行（他们的 patch 集会趟掉新坑）');
    }
  }

  console.log('\n建议：触点验证跑 node scripts/dsh-upgrade-check.mjs <目标版本>');
}

main().catch((e) => {
  console.error('radar failed:', e);
  process.exit(2);
});

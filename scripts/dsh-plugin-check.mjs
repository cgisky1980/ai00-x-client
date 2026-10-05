#!/usr/bin/env node
/**
 * dsh-plugin-check.mjs — DSH 插件市场准入检测流水线（提交上架必附报告）。
 *
 * 用法：
 *   node scripts/dsh-plugin-check.mjs <npm-spec> [--out report.json]
 *   例：node scripts/dsh-plugin-check.mjs @ai00-x/dsh-tools@0.1.0
 *
 * 流程（一次性临时 profile，全程不触碰用户 ~/.dsh 或客户端 profile）：
 *   1. 建临时 DSH_HOME + 最小 dsh profile（bundles = dsh-base）
 *   2. `dsh plugin add <npm-spec>` 装包；【静态预检】校验 manifest/bundle-patch
 *      结构 + 扫描已知炸树模式（tool schema 里出现 type 数组）
 *   3. 启动引擎 headless，轮询 host.describe 健康直到就绪
 *   4. 读 pluginInventory：目标包 entries 全 active 且整树无 failed 才算通过
 *   5. 输出 report.json 并清理全部临时产物
 *
 * 报告结构（与服务端 dsh_market submissions 合格线对齐）：
 *   { spec, packageId, version, startedAt, engineBooted, targetEntries[],
 *     targetAllActive, treeHadFailures, staticChecks[], stderrMarkers[] }
 *
 * 环境要求：本机已由 Ai00-X 桌面客户端装过一次运行环境
 * （~/.ai00-run/node/v<agent-versions.json nodeVersion> + 全局 @deepseek-ai/dsh），
 * 或通过环境变量覆盖：
 *   AI00X_CHECK_NODE_DIR   指定 node 目录（含 node.exe/npm.cmd/dsh.cmd）
 *   AI00X_CHECK_PORT       引擎端口（默认 3937，避开 sidecar 的 3210）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const specArg = args.find(a => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const keepTemp = args.includes('--keep'); // 调试用：保留临时目录并打印路径
const registryArgIdx = args.indexOf('--registry');
const NPM_REGISTRY = registryArgIdx !== -1 ? args[registryArgIdx + 1] : undefined;

if (!specArg || /[^\w@./-]/.test(specArg)) {
  console.error(
    'usage: node scripts/dsh-plugin-check.mjs <npm-spec|./local-pkg-dir> [--out report.json]',
  );
  process.exit(2);
}
// spec 必须带显式版本号（安装凭据唯一性；本地目录模式除外）
const localPkgDir = fs.existsSync(path.resolve(specArg)) && fs.statSync(path.resolve(specArg)).isDirectory()
  ? path.resolve(specArg)
  : null;
if (!localPkgDir) {
  const at = specArg.lastIndexOf('@');
  if (at === -1 || at === 0 || specArg.slice(at + 1).length === 0) {
    console.error('error: npm spec must include an explicit version, e.g. pkg@1.0.0');
    process.exit(2);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 解析 node 运行目录（含 npm/dsh 的目录）。版本单一来源：packages/shared/agent-versions.json。 */
function resolveNodeDir() {
  if (process.env.AI00X_CHECK_NODE_DIR) return process.env.AI00X_CHECK_NODE_DIR;
  const home = os.homedir();
  let nodeVersion = null;
  try {
    const versions = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'packages', 'shared', 'agent-versions.json'), 'utf8'),
    );
    nodeVersion = versions.nodeVersion;
  } catch {
    console.error('error: cannot read packages/shared/agent-versions.json');
    process.exit(2);
  }
  const candidates =
    process.platform === 'win32'
      ? [path.join(home, '.ai00-run', 'node', `v${nodeVersion}`)]
      : [path.join(home, '.ai00-run', 'node', `v${nodeVersion}`, 'bin')];
  for (const c of candidates) {
    const exe = process.platform === 'win32' ? path.join(c, 'node.exe') : path.join(c, 'node');
    if (fs.existsSync(exe)) return c;
  }
  console.error(
    'error: managed node runtime not found (~/.ai00-run/node).\n' +
      'Start the Ai00-X desktop client once to provision it, or set AI00X_CHECK_NODE_DIR.',
  );
  process.exit(2);
}

const NODE_DIR = resolveNodeDir();
// 引擎 token/cookie 与子进程句柄：waitEngineReady（模块级）也要访问，故挂模块级
let engineChild = null;
let engineToken = null;
let engineCookie = null;
// Windows 弃用 dsh.cmd shim（实测 0.2.0 长驻 web boot 经 cmd shim 静默挂起，
// dump-config 短命无碍）——与生产 dsh_manager::spawn_sidecar 同款 node 直跑。
const DSH_NODE = process.platform === 'win32' ? path.join(NODE_DIR, 'node.exe') : path.join(NODE_DIR, 'bin', 'node');
const DSH_ENTRY = path.join(NODE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DSH_BIN = DSH_NODE;
const PORT = Number(process.env.AI00X_CHECK_PORT || 3937);

if (!fs.existsSync(DSH_NODE) || !fs.existsSync(DSH_ENTRY)) {
  console.error(`error: managed node/dsh not found (${DSH_NODE} / ${DSH_ENTRY})`);
  process.exit(2);
}

function prependPath(dir) {
  const sep = process.platform === 'win32' ? ';' : ':';
  return `${dir}${sep}${process.env.PATH ?? ''}`;
}

// ---------------------------------------------------------------------------
// 静态预检
// ---------------------------------------------------------------------------

/**
 * 已知炸树模式扫描：tool schema 出现 type 数组（如 type:["string","null"]）
 * 会触发引擎 JsonSchemaError，炸掉整棵插件树（见 参考/dsh-内部业务API实施记录）。
 * 低成本 grep 式拦截：命中且邻近窗口含 schema 关键字 → error；仅命中 → warn。
 */
const SCHEMA_TYPE_ARRAY_RE = /\btype\s*:\s*\[/;
const SCHEMA_CONTEXT_RE = /\b(properties|required|items|additionalProperties)\b|\bschema\b/i;

function collectStaticChecks(packageDir, manifest) {
  /** @type {{id:string, level:string, message:string}[]} */
  const checks = [];

  // 1. manifest 完整性
  const pkgName = manifest.name ?? '(missing)';
  checks.push({
    id: 'manifest.name',
    level: typeof manifest.name === 'string' && manifest.name.length > 0 ? 'info' : 'error',
    message: `package name: ${pkgName}`,
  });
  checks.push({
    id: 'manifest.version',
    level: typeof manifest.version === 'string' && /^\d/.test(manifest.version ?? '')
      ? 'info'
      : 'error',
    message: `package version: ${manifest.version ?? '(missing)'}`,
  });
  const dshDecl = manifest.dsh;
  checks.push({
    id: 'manifest.dsh-declaration',
    level: dshDecl && typeof dshDecl === 'object' ? 'info' : 'warn',
    message: dshDecl
      ? `dsh declaration present (${Object.keys(dshDecl).join(', ')})`
      : 'no top-level "dsh" field (not a bundle plugin? confirm with curator)',
  });

  // 2. bundle patch 结构（声明了才查）
  const patchFile =
    manifest.dsh && typeof manifest.dsh.bundle === 'object' ? manifest.dsh.bundle.patch : null;
  if (patchFile) {
    const patchPath = path.join(packageDir, patchFile);
    if (!fs.existsSync(patchPath)) {
      checks.push({
        id: 'bundle.patch-exists',
        level: 'error',
        message: `bundle patch declared but missing: ${patchFile}`,
      });
    } else {
      const raw = fs.readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '');
      // 极简 yaml 校验：必须有 insert 且引用的 name 与包名一致
      const hasInsert = /(^|\n)[ \t-]*insert\s*:/.test(raw);
      const mentionsSelf = raw.includes(manifest.name ?? '\u0000');
      checks.push({
        id: 'bundle.patch-structure',
        level: hasInsert && mentionsSelf ? 'info' : 'error',
        message:
          hasInsert && mentionsSelf
            ? `bundle patch ok (${patchFile})`
            : `bundle patch invalid: insert block ${hasInsert ? '' : 'missing'}, self-reference ${mentionsSelf ? 'ok' : 'missing'} (${patchFile})`,
      });
    }
  }

  // 3. 已知炸树模式扫描（js/mjs/cjs/ts 文本）
  const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts']);
  let scanned = 0;
  let errors = 0;
  /** @type {string[]} */
  const hits = [];
  function walk(dir) {
    if (scanned > 500 || errors > 10) return; // 上限防呆
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCAN_EXTS.has(path.extname(entry.name))) {
        const rel = path.relative(packageDir, full).replaceAll('\\', '/');
        let lines;
        try {
          lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
        } catch {
          continue;
        }
        scanned++;
        for (let i = 0; i < lines.length; i++) {
          if (!SCHEMA_TYPE_ARRAY_RE.test(lines[i])) continue;
          const window = lines.slice(Math.max(0, i - 5), i + 6).join('\n');
          const nearSchema = SCHEMA_CONTEXT_RE.test(window);
          hits.push(`${rel}:${i + 1}`);
          if (nearSchema) {
            errors++;
            checks.push({
              id: 'schema.type-array',
              level: 'error',
              message: `possible JSON-schema type array at ${rel}:${i + 1} — dsh engine rejects type arrays (whole plugin tree fails to load)`,
            });
          }
        }
      }
    }
  }
  walk(packageDir);
  if (scanned > 0 && errors === 0) {
    checks.push({
      id: 'scan.type-array-clean',
      level: 'info',
      message: `scanned ${scanned} source files: no fatal schema patterns`,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// dsh CLI 封装
// ---------------------------------------------------------------------------

function runDsh(argsList, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(DSH_NODE, [DSH_ENTRY, ...argsList], {
      env: { ...opts.env },
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += String(d)));
    child.stderr.on('data', d => (stderr += String(d)));
    const timer = setTimeout(() => {
      // Windows 下 shell:true 会经 cmd.exe 链式拉起子进程，须整树杀防残留占目录
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
      reject(new Error(`dsh ${argsList[0]} timed out`));
    }, 300_000);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// 引擎探测
// ---------------------------------------------------------------------------

async function enginePost(method, payload, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(engineCookie ? { cookie: engineCookie } : {}),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `dsh-plugin-check-${Date.now()}`,
        method,
        payload,
      }),
      signal: ctrl.signal,
    });
    return { status: resp.status, body: await resp.text().catch(() => '') };
  } finally {
    clearTimeout(t);
  }
}

async function waitEngineReady(deadlineMs) {
  const start = Date.now();
  const dbg = !!process.env.AI00X_CHECK_DEBUG;
  let outBytes = 0;
  if (dbg) {
    engineChild.stdout.on('data', d => { outBytes += d.length; });
    engineChild.stderr.on('data', d => { outBytes += d.length; });
  }
  while (Date.now() - start < deadlineMs) {
    if (dbg) {
      const el = Math.round((Date.now() - start) / 1000);
      console.error(`[tick] t=${el}s pid=${engineChild?.pid ?? 'n/a'} exitCode=${engineChild?.exitCode ?? 'running'} killed=${engineChild?.killed} out=${outBytes}B token=${!!engineToken} cookie=${!!engineCookie}`);
    }
    if (engineToken && !engineCookie) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/?token=${engineToken}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(2500),
        });
        const setCookie = r.headers.getSetCookie?.()[0];
        if (setCookie) engineCookie = setCookie.split(';')[0];
      } catch {
        /* port not accepting yet */
      }
    }
    try {
      // host.describe 已随引擎 0.1.5 移除；settings/describe 是现行健康面
      //（0.2.0 起 /api 全量鉴权，enginePost 会带上面换好的 cookie）。
      const r = await enginePost('settings/describe', {}, 2500);
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/** 读插件清单（Typert 信封 result.value.entries，失败回退 plain payload）。 */
async function readInventory() {
  const r = await enginePost('pluginInventory/list', { args: {} }, 10000);
  if (r.status !== 200) return [];
  for (const body of [r.body]) {
    try {
      const json = JSON.parse(body);
      // Typert Remote 信封：{ result: { ok, value: { entries } } }
      const value = json?.result?.value ?? json?.result ?? json;
      const data = value?.ok === true ? value.value : value;
      if (Array.isArray(data?.entries)) return data.entries;
      if (Array.isArray(data)) return data;
    } catch {
      /* fallthrough */
    }
  }
  return [];
}

const TREE_FAIL_MARKERS = ['plugin tree failed to load', 'failed to apply loader entry'];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const report = {
    spec: specArg,
    packageId: null,
    version: null,
    startedAt: new Date().toISOString(),
    engineBooted: false,
    targetEntries: [],
    targetAllActive: false,
    treeHadFailures: false,
    staticChecks: [],
    stderrMarkers: [],
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-check-'));
  const home = path.join(tmpRoot, 'home');
  const profile = path.join(home, 'profiles', 'ai00x-check');
  fs.mkdirSync(profile, { recursive: true });

  try {
    // 1. 最小 profile（只挂 dsh-base，装轻量、加载快）
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-ai00x-check',
          private: true,
          dependencies: {},
          // 0.2.0 起 web 服务端从 dsh-base 拆出为显式 bundle（缺它 boot 静默挂起）
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
    fs.writeFileSync(
      path.join(profile, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    );

    const env = { ...process.env, DSH_HOME: home, PATH: prependPath(NODE_DIR) };

    // 2. 装包（本地目录 → dsh plugin add <abs-path>，npm file 语义）
    const installTarget = localPkgDir ?? specArg;
    const addArgs = ['plugin', '--profile', 'ai00x-check', 'add', installTarget];
    if (NPM_REGISTRY) addArgs.push(`--registry=${NPM_REGISTRY}`);
    const added = await runDsh(addArgs, { env, cwd: profile });
    if (added.code !== 0) {
      report.staticChecks.push({
        id: 'install.add',
        level: 'error',
        message: `dsh plugin add failed: ${(added.stderr || added.stdout).slice(-600)}`,
      });
      throw new Error('install failed');
    }

    // 3. 解析包 id/version 并静态预检
    let pkgId;
    if (localPkgDir) {
      const localManifest = JSON.parse(
        fs.readFileSync(path.join(localPkgDir, 'package.json'), 'utf8'),
      );
      pkgId = localManifest.name ?? path.basename(localPkgDir);
      report.version = localManifest.version ?? '';
    } else {
      const at = specArg.lastIndexOf('@');
      pkgId = specArg.slice(0, at);
      report.version = specArg.slice(at + 1);
    }
    report.packageId = pkgId;
    const nmPkgDir = pkgId.startsWith('@')
      ? path.join(profile, 'node_modules', ...pkgId.split('/'))
      : path.join(profile, 'node_modules', pkgId);
    const manifest = JSON.parse(fs.readFileSync(path.join(nmPkgDir, 'package.json'), 'utf8'));
    report.staticChecks.push(...collectStaticChecks(nmPkgDir, manifest));

    // 4. 启动引擎 headless（泵空管道防缓冲写满阻塞）
    const debugBoot = !!process.env.AI00X_CHECK_DEBUG;
    engineChild = spawn(
      DSH_BIN,
      // 0.2.0 CLI 变更：`web` 子命令取消，改为内置 shipped profile "web"；
      // 启动被检 profile 必须用 `dsh --profile <name> [options]` 形式，
      // 且不能在 options 后再跟 "web"（会被当作 profile 的 app 参数挂起）。
      [DSH_ENTRY, '--profile', 'ai00x-check', '--no-open', '--host', '127.0.0.1', '--port', String(PORT)],
      {
        env,
        cwd: profile,
        shell: false,
        // debug 模式直连控制台：引擎秒退时错误信息直接可见（pipe 下会丢）
        stdio: debugBoot ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      },
    );
    const errChunks = [];
    engineChild.on('error', e => {
      console.error('[dsh-plugin-check] engine spawn error:', String(e));
    });
    engineChild.on('exit', (code, sig) => {
      if (debugBoot) console.error(`[dsh-plugin-check] engine exited early: code=${code} sig=${sig}`);
    });
    // 0.2.0 起 /api 全量鉴权（无按方法 loopback 豁免）：从 stdout 抓一次性
    // 启动 token，GET /?token= 换签名 cookie 后随探测请求携带（0.1.5 亦兼容）。
    engineChild.stdout.on('data', d => {
      const text = String(d);
      if (debugBoot) console.error('[engine-out]', text.trimEnd());
      const m = text.match(/\?token=([A-Za-z0-9_-]+)/);
      if (m && !engineToken) engineToken = m[1];
    });
    engineChild.stderr.on('data', d => {
      const text = String(d);
      if (debugBoot) console.error('[engine-err]', text.trimEnd());
      errChunks.push(text);
      for (const marker of TREE_FAIL_MARKERS) {
        if (text.includes(marker) && !report.stderrMarkers.includes(marker)) {
          report.stderrMarkers.push(marker);
        }
      }
    });

    report.engineBooted = await waitEngineReady(90_000);
    if (!report.engineBooted) {
      report.staticChecks.push({
        id: 'engine.boot',
        level: 'error',
        message: `engine did not become healthy on port ${PORT}. stderr tail: ${errChunks.join('').slice(-600)}`,
      });
      throw new Error('engine boot failed');
    }

    // 5. 清单评估
    const entries = await readInventory();
    if (keepTemp) {
      console.error('[dsh-plugin-check] --keep: raw pluginInventory/list entries:');
      console.error(JSON.stringify(entries, null, 2));
    }
    report.targetEntries = entries.filter(e => e.moduleName === pkgId);
    report.targetAllActive =
      report.targetEntries.length > 0 &&
      report.targetEntries.every(e => e.fiberPhase === 'active' && e.enabled);
    const anyFailed = entries.some(e => e.fiberPhase === 'failed');
    report.treeHadFailures = anyFailed || report.stderrMarkers.length > 0;

    const pass =
      report.staticChecks.every(c => c.level !== 'error') &&
      report.engineBooted &&
      report.targetAllActive &&
      !report.treeHadFailures;
    report.pass = pass;
    console.log(JSON.stringify(report, null, 2));
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(pass ? `[dsh-plugin-check] PASS ${specArg}` : `[dsh-plugin-check] FAIL ${specArg}`);
    process.exitCode = pass ? 0 : 1;
  } catch (err) {
    report.pass = false;
    console.error('[dsh-plugin-check] aborted:', err.message);
    console.log(JSON.stringify(report, null, 2));
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    if (engineChild) {
      if (process.platform === 'win32' && engineChild.pid) {
        try {
          spawn('taskkill', ['/pid', String(engineChild.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          /* best effort */
        }
      } else {
        try {
          engineChild.kill();
        } catch {
          /* already dead */
        }
      }
    }
    await new Promise(r => setTimeout(r, 1500));
    if (keepTemp) {
      console.error(`[dsh-plugin-check] --keep: temp dir preserved at ${tmpRoot}`);
    } else {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch (e) {
        console.warn(`warning: temp cleanup failed: ${tmpRoot} (${e.message})`);
      }
    }
  }
}

main();

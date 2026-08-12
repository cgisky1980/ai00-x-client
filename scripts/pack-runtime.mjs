#!/usr/bin/env node
/**
 * pack-runtime.mjs
 *
 * Collects locally-built runtime DLLs into `target/release/runtime/` for
 * bundling into the installer. Core principle: "build what you can compile,
 * package it with the app" — no runtime download for these components.
 *
 * Source → Destination layout (matches `inference::runtime::init` lookups):
 *   .llama-build/bin/Release/llama.dll            → runtime/llama/<ver>-<backend>/llama.dll
 *   .llama-build/bin/Release/ggml-*.dll           → runtime/gguf/ggml-*.dll        (shared)
 *   .llama-build/bin/Release/qwen3_fa.dll         → runtime/gguf/qwen3_fa.dll
 *   acestep OUT_DIR/.../acestep-build/Release/acestep_c.dll → runtime/acestep/<ver>/acestep_c.dll
 *   acestep OUT_DIR/.../acestep-build/Release/ggml-*.dll   → runtime/gguf/ggml-*.dll (shared)
 *
 * onnxruntime is NOT compiled from source (compiling ONNX Runtime takes 1-2h
 * and is impractical). It is pre-downloaded from the official GitHub release
 * and bundled with the app. Acestep + llama + ggml + qwen3_fa are compiled
 * from source and collected below.
 *
 * onnxruntime-<os>-<arch>-<ver>.zip/tgz (downloaded)     → runtime/onnx/<ver>/onnxruntime.*
 */
import { existsSync, readdirSync, mkdirSync, copyFileSync, rmSync, statSync, readFileSync, createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'target');
const RELEASE = join(TARGET, 'release');
const RUNTIME = join(RELEASE, 'runtime');

const VERSIONS = {
  llama: 'b9113',
  acestep: '0.0.1',
  onnx: '1.23.2',
  mnn: '1.0.0',
};

const DLL_EXTS = ['.dll', '.so', '.dylib'];

function log(msg) {
  console.log(`[pack-runtime] ${msg}`);
}

function isLibFile(name) {
  return DLL_EXTS.some((ext) => name.endsWith(ext));
}

// Prune non-library artifacts (pdb/lib) from a runtime subdir tree.
// Keeps `.active_backend` marker files (written by the runtime).
function pruneNonLibs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneNonLibs(full);
      // Remove emptied subdirectories (e.g. onnx's `lib/` after .lib pruned).
      if (existsSync(full) && readdirSync(full).length === 0) {
        rmSync(full, { recursive: true, force: true });
        log(`pruned empty dir ${full.replace(ROOT + '\\', '')}`);
      }
    } else if (entry.name === '.active_backend') {
      // preserve runtime state marker
      continue;
    } else if (!isLibFile(entry.name)) {
      rmSync(full, { force: true });
      log(`pruned ${full.replace(ROOT + '\\', '')}`);
    }
  }
}

function copyLib(src, dst) {
  if (!existsSync(src)) {
    log(`! missing source: ${src}`);
    return false;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  log(`copied ${basename(src)} (${Math.round(statSync(src).size / 1024 / 1024 * 10) / 10} MB)`);
  return true;
}

// Find the actual build output dir for llama (Visual Studio → bin/Release, Ninja → bin).
function findLlamaLibDir() {
  const candidates = [
    join(ROOT, '.llama-build', 'bin', 'Release'),
    join(ROOT, '.llama-build', 'bin'),
    join(ROOT, '.llama-build'),
  ];
  return candidates.find((d) => existsSync(join(d, 'llama.dll')));
}

// Find the acestep build output dir across all OUT_DIR candidates.
function findAcestepLibDir() {
  const buildRoot = join(TARGET, 'release', 'build');
  if (!existsSync(buildRoot)) return null;
  for (const crateDir of readdirSync(buildRoot)) {
    if (!crateDir.startsWith('ai00-x-acestep-')) continue;
    const out = join(buildRoot, crateDir, 'out', 'acestep-build');
    const candidates = [
      join(out, 'Release'),
      join(out, 'bin', 'Release'),
      join(out, 'bin'),
      out,
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'acestep_c.dll'))) return c;
    }
  }
  return null;
}

async function main() {
  mkdirSync(RUNTIME, { recursive: true });

  // ── 1. llama (llama.dll + ggml + qwen3_fa) ────────────────────────
  const llamaDir = findLlamaLibDir();
  if (llamaDir) {
    // Determine the backend directory segment from the runtime's own marker
    // (`.active_backend`), fall back to env, then to a sensible default.
    // Runtime looks up `runtime/llama/<LLAMA_CPP_VERSION>-<backend>/`.
    const activeMarker = join(RUNTIME, 'llama', '.active_backend');
    let backend = 'cuda-12.4';
    if (existsSync(activeMarker)) {
      backend = readFileSync(activeMarker).toString().trim();
    } else if (process.env.LLAMA_BACKEND) {
      backend = process.env.LLAMA_BACKEND;
    }
    const segment = backend === 'metal' || backend === '' ? VERSIONS.llama : `${VERSIONS.llama}-${backend}`;
    const llamaTarget = join(RUNTIME, 'llama', segment);
    // The full llama DLL set (llama.dll + its ggml) must stay co-located so
    // the Windows loader resolves GGML deps when loading llama.dll.
    for (const f of readdirSync(llamaDir)) {
      if (isLibFile(f)) {
        copyLib(join(llamaDir, f), join(llamaTarget, f));
      }
    }
    // Shared GGML DLLs → runtime/gguf (used by acestep/qwen3_fa).
    const gguf = join(RUNTIME, 'gguf');
    for (const f of readdirSync(llamaDir)) {
      if ((f.startsWith('ggml') || f.startsWith('qwen3_fa')) && isLibFile(f)) {
        copyLib(join(llamaDir, f), join(gguf, f));
      }
    }
  } else {
    log('WARN: llama build output not found (.llama-build missing) — run cargo build first');
  }

  // ── 2. acestep (acestep_c.dll + its ggml) ─────────────────────────
  const acestepDir = findAcestepLibDir();
  if (acestepDir) {
    const acestepTarget = join(RUNTIME, 'acestep', VERSIONS.acestep);
    copyLib(join(acestepDir, 'acestep_c.dll'), join(acestepTarget, 'acestep_c.dll'));
    const gguf = join(RUNTIME, 'gguf');
    for (const f of readdirSync(acestepDir)) {
      if (f.startsWith('ggml') && isLibFile(f)) {
        copyLib(join(acestepDir, f), join(gguf, f));
      }
    }
  } else {
    log('WARN: acestep build output not found — run cargo build first');
  }

  // ── 3. onnxruntime: pre-download official release (not compiled) ──
  // ONNX Runtime is too large / slow to compile from source; download the
  // official prebuilt release and extract only the shared library into
  // runtime/onnx/<ver>/. Skip if already present.
  downloadOnnxRuntime();

  // ── 3b. mnn: pre-download upstream prebuilt libs (not compiled) ──
  // SA3 models run on MNN via mnn_dit_bridge. The bridge C source lives in
  // the cgisky1980/MNN fork; upstream stable-audio-3-rs publishes prebuilt
  // `mnn-libs-{platform}-{backend}.{zip|tar.gz}`. Download & extract into
  // runtime/mnn/<ver>/. Skip if already present.
  downloadMnnRuntime();

  // ── 4. onnxruntime / mnn / llama / gguf: prune non-libs ───────────
  // Keep any existing .active_backend marker file (runtime writes it).
  pruneNonLibs(join(RUNTIME, 'onnx'));
  pruneNonLibs(join(RUNTIME, 'mnn'));
  pruneNonLibs(join(RUNTIME, 'llama'));
  pruneNonLibs(join(RUNTIME, 'gguf'));

  log('done. runtime assembled at ' + RUNTIME);
}

// ── onnxruntime predownload ─────────────────────────────────────────
// Official naming: onnxruntime-<os>-<arch>-<ver>.zip (win) / .tgz (linux/osx).
// Download from the official GitHub release, extract the shared lib into
// runtime/onnx/<ver>/. Uses system `tar` (bsdtar) which handles zip/tgz.
// Mirrors the lookup in inference::runtime::downloader::download_onnx_runtime.
function onnxPlatform() {
  const os =
    process.platform === 'win32' ? 'win'
    : process.platform === 'darwin' ? 'osx'
    : process.platform === 'linux' ? 'linux'
    : null;
  const arch =
    process.arch === 'x64' ? 'x64'
    : process.arch === 'arm64' ? 'arm64'
    : null;
  return os && arch ? { os, arch, ext: os === 'win' ? 'zip' : 'tgz' } : null;
}

function runTar(args, cwd) {
  const r = spawnSync('tar', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) throw new Error(`tar error: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar exited ${r.status}`);
}

async function downloadOnnxRuntime() {
  const url = 'https://github.com/microsoft/onnxruntime/releases/download';
  const ver = VERSIONS.onnx;
  const ortDir = join(RUNTIME, 'onnx', ver);
  const libName =
    process.platform === 'win32' ? 'onnxruntime.dll'
    : process.platform === 'darwin' ? 'libonnxruntime.dylib'
    : 'libonnxruntime.so';

  if (existsSync(join(ortDir, libName))) {
    log(`onnxruntime ${ver} already present, skipping download`);
    return;
  }

  const plat = onnxPlatform();
  if (!plat) {
    log(`WARN: unsupported platform ${process.platform}/${process.arch}, onnxruntime not downloaded`);
    return;
  }

  const filename = `onnxruntime-${plat.os}-${plat.arch}-${ver}.${plat.ext}`;
  const targetUrl = `${url}/v${ver}/${filename}`;
  const tmpDir = join(RUNTIME, 'onnx', '.onnx-download');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, filename);

  log(`Downloading onnxruntime ${ver} (${plat.os}-${plat.arch})...`);
  try {
    const res = await fetch(targetUrl, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} for ${targetUrl}`);
    }
    await pipeline(res.body, createWriteStream(archive));
  } catch (e) {
    log(`WARN: onnxruntime download failed (${e.message}). TTS will require a manual runtime.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // Extract the shared lib into runtime/onnx/<ver>/. The archive has a
  // top-level dir `onnxruntime-<os>-<arch>-<ver>/lib/<libName>`; strip it.
  const extractDir = join(tmpDir, 'extract');
  mkdirSync(extractDir, { recursive: true });
  try {
    runTar(plat.ext === 'zip' ? ['-xf', archive, '-C', extractDir] : ['-xzf', archive, '-C', extractDir]);
  } catch (e) {
    log(`WARN: onnxruntime extract failed (${e.message}); TTS will require a manual runtime.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // Copy all shared libs (onnxruntime.dll + providers_shared.dll, etc.) into
  // runtime/onnx/<ver>/, mirroring the runtime downloader's full `lib/`
  // extraction. `onnxruntime_providers_shared.dll` is required for the CUDA
  // execution provider used by TTS.
  const found = collectLibFiles(extractDir);
  if (found.length === 0) {
    log(`WARN: no shared libs found in onnxruntime archive; TTS will require a manual runtime.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(ortDir, { recursive: true });
  for (const src of found) {
    copyFileSync(src, join(ortDir, basename(src)));
    log(`  onnx lib ${basename(src)} (${Math.round(statSync(src).size / 1024 / 1024 * 10) / 10} MB)`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── mnn predownload ────────────────────────────────────────────────
// SA3 (StableAudio3) models run on MNN via mnn_dit_bridge. The C bridge
// source lives in the cgisky1980/MNN fork; upstream stable-audio-3-rs
// publishes prebuilt archives `mnn-libs-<platform>-<backend>.{zip|tar.gz}`
// (platform = windows-latest/ubuntu-latest/macos-latest, backend = cuda/metal).
// Runtime expects MNN.dll + mnn_dit_bridge.dll in runtime/mnn/<ver>/.
function mnnPlatform() {
  const os =
    process.platform === 'win32' ? 'windows-latest'
    : process.platform === 'darwin' ? 'macos-latest'
    : process.platform === 'linux' ? 'ubuntu-latest'
    : null;
  const backend =
    process.platform === 'darwin' ? 'metal'
    : (process.platform === 'win32' || process.platform === 'linux') ? 'cuda'
    : null;
  if (!os || !backend) return null;
  return { os, backend, ext: process.platform === 'win32' ? 'zip' : 'tar.gz' };
}

async function downloadMnnRuntime() {
  const ver = VERSIONS.mnn;
  const mnnDir = join(RUNTIME, 'mnn', ver);
  const bridgeName =
    process.platform === 'win32' ? 'mnn_dit_bridge.dll'
    : process.platform === 'darwin' ? 'libmnn_dit_bridge.dylib'
    : 'libmnn_dit_bridge.so';

  if (existsSync(join(mnnDir, bridgeName))) {
    log(`mnn ${ver} already present, skipping download`);
    return;
  }

  const plat = mnnPlatform();
  if (!plat) {
    log(`WARN: unsupported platform ${process.platform}/${process.arch}, mnn not downloaded`);
    return;
  }

  const filename = `mnn-libs-${plat.os}-${plat.backend}.${plat.ext}`;
  const targetUrl = `https://github.com/cgisky1980/stable-audio-3-rs/releases/latest/download/${filename}`;
  const tmpDir = join(RUNTIME, 'mnn', '.mnn-download');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, filename);

  log(`Downloading mnn libs (${plat.os}, ${plat.backend})...`);
  try {
    const res = await fetch(targetUrl, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} for ${targetUrl}`);
    }
    await pipeline(res.body, createWriteStream(archive));
  } catch (e) {
    log(`WARN: mnn download failed (${e.message}). SA3 audio-gen will require a manual runtime.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const extractDir = join(tmpDir, 'extract');
  mkdirSync(extractDir, { recursive: true });
  try {
    runTar(plat.ext === 'zip' ? ['-xf', archive, '-C', extractDir] : ['-xzf', archive, '-C', extractDir]);
  } catch (e) {
    log(`WARN: mnn extract failed (${e.message}); SA3 audio-gen will require a manual runtime.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // Copy all shared libs found in the archive into runtime/mnn/<ver>/.
  const found = collectLibFiles(extractDir);
  if (found.length === 0) {
    log(`WARN: no shared libs found in mnn archive; SA3 audio-gen will require a manual runtime.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(mnnDir, { recursive: true });
  for (const src of found) {
    copyFileSync(src, join(mnnDir, basename(src)));
    log(`  mnn lib ${basename(src)} (${Math.round(statSync(src).size / 1024 / 1024 * 10) / 10} MB)`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

function collectLibFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (isLibFile(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

main().catch((e) => {
  console.error('[pack-runtime] fatal:', e);
  process.exit(1);
});
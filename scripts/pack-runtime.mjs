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
 *
 * CUDA runtime (cudart/cublas/cublasLt) is a CUDA Toolkit dependency that is
 * NOT part of the local llama build output. It is downloaded from the official
 * llama.cpp release asset `cudart-llama-bin-win-cuda-<ver>-x64.zip` (built
 * with the same CUDA toolchain) into runtime/llama/<ver>-cuda-<x.y>/.
 */
import { existsSync, readdirSync, mkdirSync, copyFileSync, rmSync, statSync, readFileSync, createWriteStream, realpathSync } from 'fs';
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
  llama: 'b10369',
  acestep: '0.0.1',
  onnx: '1.23.2',
  mnn: '1.0.0',
};

const DLL_EXTS = ['.dll', '.so', '.dylib'];

// GitHub mirrors (kept in sync with inference::runtime::downloader).
const GITHUB_MIRRORS = [
  '',
  'https://ghproxy.net',
  'https://mirror.ghproxy.com',
  'https://gh-proxy.com',
];

// Download a GitHub URL to a file, falling back through mirrors when either
// the connection or the streamed transfer is terminated mid-flight.
async function downloadWithMirrors(originalUrl, destPath) {
  let lastErr = 'no mirrors available';
  for (const mirror of GITHUB_MIRRORS) {
    const url = mirror ? `${mirror}/${originalUrl}` : originalUrl;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        lastErr = `HTTP ${res.status} for ${url}`;
        continue;
      }
      await pipeline(res.body, createWriteStream(destPath));
      log(`downloaded via ${mirror || 'direct github'}`);
      return;
    } catch (e) {
      lastErr = `${url}: ${e.message}`;
      log(`WARN: mirror failed (${lastErr}), trying next...`);
      rmSync(destPath, { force: true });
    }
  }
  throw new Error(lastErr);
}

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

// Resolve the llama backend from the runtime's own marker (`.active_backend`),
// falling back to env, then to a sensible default. The runtime looks up
// `runtime/llama/<LLAMA_CPP_VERSION>-<backend>/`.
function resolveLlamaBackend() {
  const activeMarker = join(RUNTIME, 'llama', '.active_backend');
  if (existsSync(activeMarker)) {
    return readFileSync(activeMarker).toString().trim();
  }
  if (process.env.LLAMA_BACKEND) {
    return process.env.LLAMA_BACKEND;
  }
  return 'cuda-12.4';
}

async function main() {
  mkdirSync(RUNTIME, { recursive: true });

  const backend = resolveLlamaBackend();
  const segment = backend === 'metal' || backend === '' ? VERSIONS.llama : `${VERSIONS.llama}-${backend}`;
  const llamaTarget = join(RUNTIME, 'llama', segment);

  // ── 1. llama (llama.dll + ggml + qwen3_fa) ────────────────────────
  const llamaDir = findLlamaLibDir();
  if (llamaDir) {
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

  // ── 1b. CUDA runtime (cudart/cublas) from official llama.cpp release ──
  // ggml-cuda.dll depends on cudart64_*.dll + cublas64_*.dll which are CUDA
  // Toolkit dependencies and never appear in the local build output. The
  // official `cudart-llama-bin-win-cuda-<x.y>-x64.zip` release asset ships
  // the exact runtime set for the same CUDA toolchain.
  await downloadCudaRuntime(backend, llamaTarget);

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

  // ── 5. optional: pack the assembled runtime into a distributable zip ──
  // `--pack-zip` produces dist/runtime-<os>-<arch>-<segment>.zip (contents at
  // zip root) for the split-installer first-run download channel. The
  // platform tag keeps windows/linux/macos runtimes distinct — the manifest
  // (resources-manifest-<os>-<arch>.json) points each platform at its zip.
  if (process.argv.includes('--pack-zip')) {
    packRuntimeZip(segment);
  }
}

// Tauri-style platform id (matches std::env::consts::{OS, ARCH} consumed by
// resource_manager.rs): windows-x86_64 / linux-x86_64 / darwin-aarch64 …
function platformId() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${os}-${arch}`;
}

// Zip the assembled runtime dir (resolving a possible junction) into
// dist/runtime-<platform>-<segment>.zip via scripts/zip-dir.mjs.
function packRuntimeZip(segment) {
  const dist = join(ROOT, 'dist');
  mkdirSync(dist, { recursive: true });
  const zipName = `runtime-${platformId()}-${segment}.zip`;
  const dest = join(dist, zipName);
  // Drop stale runtime zips (old no-platform name or other platforms) so
  // desktop-tauri-build.mjs's `find(/^runtime-.*\.zip$/)` can't pick wrong.
  for (const f of readdirSync(dist)) {
    if (/^runtime-.*\.zip$/.test(f) && f !== zipName) {
      log(`removing stale runtime zip: ${f}`);
      rmSync(join(dist, f), { force: true });
    }
  }
  // RUNTIME may be a junction (→ .ai00-x-dev/runtime); zip the real dir.
  const realRuntime = realpathSync(RUNTIME);
  log(`packing runtime zip: ${realRuntime} -> ${dest}`);
  const r = spawnSync(
    process.execPath,
    [join(__dirname, 'zip-dir.mjs'), realRuntime, dest],
    { stdio: 'inherit' }
  );
  if (r.error || r.status !== 0) {
    log(`WARN: runtime zip packing failed (${r.error ? r.error.message : `exit ${r.status}`})`);
    process.exit(1);
  }
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
  // Prefer the Windows built-in bsdtar (handles zip+tgz). A MSYS/Git-Bash
  // GNU tar on PATH cannot read zip and misparses "C:\..." as host:path.
  const tarExe =
    process.platform === 'win32' && existsSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'))
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const r = spawnSync(tarExe, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
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

// ── CUDA runtime predownload ───────────────────────────────────────
// Windows CUDA backends need cudart64_*.dll + cublas64_*.dll (+cublasLt)
// next to ggml-cuda.dll. Download the official llama.cpp cudart bundle
// `cudart-llama-bin-win-cuda-<x.y>-x64.zip` for the SAME llama version and
// backend, extract its DLLs into runtime/llama/<ver>-cuda-<x.y>/. Skip when
// the cudart DLL is already present.
async function downloadCudaRuntime(backend, llamaTarget) {
  if (process.platform !== 'win32' || !backend.startsWith('cuda-')) {
    return;
  }

  // Detect an existing cudart for this CUDA major (cudart64_12.dll / 13 ...).
  const cudaMajor = backend.split('-')[1]?.split('.')[0];
  const cudartName = `cudart64_${cudaMajor}.dll`;
  if (existsSync(join(llamaTarget, cudartName))) {
    log(`CUDA runtime (${cudartName}) already present, skipping download`);
    return;
  }

  const filename = `cudart-llama-bin-win-${backend}-x64.zip`;
  const targetUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${VERSIONS.llama}/${filename}`;
  const tmpDir = join(RUNTIME, 'llama', '.cuda-download');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, filename);

  log(`Downloading CUDA runtime for ${backend} from official llama.cpp release...`);
  try {
    await downloadWithMirrors(targetUrl, archive);
  } catch (e) {
    log(`WARN: CUDA runtime download failed (${e.message}). GPU backends will require a CUDA Toolkit on PATH.`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const extractDir = join(tmpDir, 'extract');
  mkdirSync(extractDir, { recursive: true });
  try {
    runTar(['-xf', archive, '-C', extractDir]);
  } catch (e) {
    log(`WARN: CUDA runtime extract failed (${e.message}).`);
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // The archive holds only the CUDA runtime DLLs (cudart/cublas/cublasLt...).
  const found = collectLibFiles(extractDir);
  if (found.length === 0) {
    log('WARN: no shared libs found in cudart archive.');
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(llamaTarget, { recursive: true });
  for (const src of found) {
    copyFileSync(src, join(llamaTarget, basename(src)));
    log(`  cuda lib ${basename(src)} (${Math.round(statSync(src).size / 1024 / 1024 * 10) / 10} MB)`);
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
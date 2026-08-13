#!/usr/bin/env node
/**
 * build-windows.mjs
 *
 * Local Windows build for the project's pure-Rust server crates.
 *
 * Scope decision: we currently only build the Windows version locally. The
 * full desktop app (tauri GUI, llama.cpp C++, CUDA/Vulkan/Metal SDKs) is NOT
 * built here — those backends must be produced on native runners via the
 * Desktop Package workflow. This script targets the backend/server crates.
 *
 * It uses the native Windows msvc toolchain (no Docker / cross needed).
 *
 * Usage:
 *   node scripts/build-windows.mjs                          # defaults below
 *   node scripts/build-windows.mjs --package ai00-x-relay
 *   node scripts/build-windows.mjs --release
 *   node scripts/build-windows.mjs --verbose
 *
 * Options:
 *   --package <name>   crate to build (default: ai00-x-relay)
 *   --release          build with --release (default: debug)
 *   --verbose          pass -v to cargo
 */
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const PACKAGE = arg('--package', 'ai00-x-relay');
const RELEASE = args.includes('--release');
const VERBOSE = args.includes('--verbose');

// Pure-Rust server/backend crates we build on Windows.
const ELIGIBLE = new Set([
  'ai00-x-relay',
  'ai00-x-transport',
  'ai00-x-events',
  'ai00-x-tool-framework',
]);

function fail(msg) {
  console.error(`[build] ${msg}`);
  process.exit(1);
}

if (!ELIGIBLE.has(PACKAGE)) {
  console.warn(
    `[build] WARNING: '${PACKAGE}' is not in the known pure-Rust set ${[...ELIGIBLE]}. ` +
      'Windows build may fail if it depends on C++/system/GUI libraries.'
  );
}

const cmd = ['cargo', 'build', '--package', PACKAGE];
if (RELEASE) cmd.push('--release');
if (VERBOSE) cmd.push('-v');

console.log(`[build] building ${PACKAGE} for x86_64-pc-windows-msvc${RELEASE ? ' (release)' : ' (debug)'}`);
console.log(`[build] ${cmd.join(' ')}`);

const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: true });
if (res.status !== 0) {
  fail(`cargo build exited with code ${res.status ?? 'unknown'}`);
}
console.log('[build] OK');
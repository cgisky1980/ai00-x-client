#!/usr/bin/env node
/**
 * ensure-placeholder-resources.mjs
 *
 * CI-only helper. `cargo check --workspace` triggers tauri-build, which
 * validates the resources listed in `src/apps/desktop/tauri.conf.json`
 * (dist/loader.zip, target/release/runtime-staging) and aborts if
 * any of them are missing. A full packaging build is deliberately NOT part of
 * CI (GitHub Actions only does syntax checks here), so we synthesize minimal
 * placeholder resources that let tauri-build's existence check pass.
 *
 * The zips are valid empty archives (created via scripts/zip-dir.mjs from an
 * empty staged dir), so nothing downstream that merely checks for the file
 * breaks. They are only used for compile-time validation, never shipped.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(process.cwd());

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

function makePlaceholderZip(name) {
  const srcDir = join(ROOT, 'dist', name);
  const destZip = join(ROOT, 'dist', `${name}.zip`);
  if (existsSync(destZip)) {
    console.log(`[ci] placeholder exists, skipping: ${destZip}`);
    return;
  }
  // Stage an empty dir with a marker file so zip-dir.mjs produces a valid zip
  // (Compress-Archive fails on a truly empty source dir on Windows).
  const stage = mkdtempSync(join(tmpdir(), `placeholder-${name}-`));
  writeFileSync(join(stage, '.ci-placeholder'), '');
  ensureDir(srcDir);
  // zip-dir resolves srcDir relative to cwd; we staged elsewhere, so point it
  // at the permanent (empty) srcDir after copying the marker in.
  writeFileSync(join(srcDir, '.ci-placeholder'), '');
  const res = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'zip-dir.mjs'),
    srcDir,
    destZip,
  ], { stdio: 'inherit' });
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
  if (res.status !== 0) {
    console.error(`[ci] failed to create placeholder ${destZip}`);
    process.exit(1);
  }
  console.log(`[ci] placeholder created: ${destZip}`);
}

makePlaceholderZip('loader');

// tauri.conf.json also lists ../../../target/release/runtime-staging as a
// bundle resource (maps to the bundled `runtime` dir). It must exist for
// tauri-build's resource validation; the actual runtime DLLs are staged there
// at bundle time (scripts/runtime-staging.mjs --stage).
ensureDir(join(ROOT, 'target', 'release', 'runtime-staging'));

console.log('[ci] placeholder resources ensured.');
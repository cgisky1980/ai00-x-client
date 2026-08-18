#!/usr/bin/env node
/**
 * runtime-staging.mjs
 *
 * Manages the tauri bundle-resource staging directory for the runtime DLLs.
 *
 *   --clear : empty `target/release/runtime-staging`. Called before ANY cargo
 *             build (beforeBuildCommand / beforeDevCommand / desktop-tauri-build.mjs)
 *             so that tauri-build's resource walk only ever sees an empty dir.
 *   --stage : copy the assembled `target/release/runtime` into the staging dir.
 *             Called from `bundle.beforeBundleCommand` — i.e. AFTER the final
 *             cargo build and right BEFORE bundling — so the installer still
 *             ships the full runtime.
 *
 * Why: tauri-build walks every file under a `bundle.resources` directory on
 * each cargo build (to emit rerun-if-changed / verify existence). Walking the
 * large, already-populated `target/release/runtime` intermittently failed with
 * `os error 32` (a transient AV/Defender lock while reading a DLL). Keeping the
 * directory tauri-build sees empty at build time and populated only at bundle
 * time removes that race entirely.
 *
 * The bundled runtime still ends up at `<app_root>/runtime` because the
 * resource maps `runtime-staging -> runtime`.
 */
import { cpSync, existsSync, mkdirSync, rmSync, realpathSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(process.cwd());
const REAL = join(ROOT, 'target', 'release', 'runtime');
const STAGING = join(ROOT, 'target', 'release', 'runtime-staging');

const mode = process.argv[2];

function ensureEmpty(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

if (mode === '--clear') {
  ensureEmpty(STAGING);
  console.log(`[runtime-staging] cleared ${STAGING}`);
} else if (mode === '--stage') {
  if (existsSync(REAL)) {
    ensureEmpty(STAGING);
    // `target/release/runtime` may be a junction (e.g. → `.ai00-x-dev/runtime`).
    // Resolve it to its real directory first so cpSync copies the actual content
    // as plain files instead of trying to recreate the junction (which fails with
    // EEXIST / ERR_FS_CP_NON_DIR_TO_DIR). `force` covers any stale copy from a
    // previous --stage run.
    const realDir = realpathSync(REAL);
    cpSync(realDir, STAGING, { recursive: true, force: true });
    console.log(`[runtime-staging] staged ${realDir} -> ${STAGING}`);
  } else {
    console.log(`[runtime-staging] ${REAL} missing; nothing staged`);
  }
} else {
  console.error('[runtime-staging] usage: --clear | --stage');
  process.exit(1);
}

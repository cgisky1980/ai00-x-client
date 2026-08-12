#!/usr/bin/env node
/**
 * Runs `tauri build` from src/apps/desktop with CI=true.
 * On Windows: shared OpenSSL bootstrap (see ensure-openssl-windows.mjs).
 */
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, existsSync } from 'fs';
import { ensureOpenSslWindows } from './ensure-openssl-windows.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function tauriBuildArgsFromArgv() {
  const args = process.argv.slice(2);
  // `node script.mjs -- --foo` leaves a leading `--`; strip so `tauri build` sees the same argv as before.
  let i = 0;
  while (i < args.length && args[i] === '--') {
    i += 1;
  }
  return args.slice(i);
}

async function main() {
  const forward = tauriBuildArgsFromArgv();

  await ensureOpenSslWindows();

  // Build all frontend artifacts (web UI, loader, main.zip, underlay.zip)
  // BEFORE the cargo pre-build below. tauri-build validates the resources
  // listed in tauri.conf.json (dist/main.zip, dist/underlay.zip) during
  // cargo build, so they must exist by then. The previous PowerShell-only
  // zip step silently failed on Linux/macOS runners, aborting the build
  // with "resource path `../../../dist/underlay.zip` doesn't exist".
  console.log('[frontend] Building web/loader/underlay + zips (build:all)...');
  try {
    execSync('pnpm run build:all', {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log('[frontend] build:all completed');
  } catch (e) {
    console.error('[frontend] build:all failed:', e.message);
    process.exit(1);
  }

  const desktopDir = join(ROOT, 'src', 'apps', 'desktop');
  // Tauri CLI reads CI and rejects numeric "1" (common in CI providers).
  process.env.CI = 'true';

  // Assemble locally-built runtime DLLs into target/release/runtime/ so they
  // get bundled into the installer (see tauri.conf.json resources).
  //
  // pack-runtime.mjs collects build outputs (llama.dll, ggml, acestep_c.dll,
  // qwen3_fa.dll) produced by the crate build.rs scripts. Those only exist
  // after `cargo build`, but Tauri's beforeBuildCommand runs before cargo
  // build, so we must compile first here. This mirrors what `tauri build`
  // compiles (release, the ai00-x-desktop bin pulls in inference + acestep),
  // and Tauri reuses the already-built artifacts.
  console.log('[runtime] Pre-building release (so pack-runtime finds outputs)...');
  try {
    execSync('cargo build --release -p ai00-x-desktop', {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } catch (e) {
    console.error('[runtime] cargo pre-build failed:', e.message);
    process.exit(1);
  }

  console.log('[runtime] Collecting runtime DLLs...');
  try {
    execSync('node scripts/pack-runtime.mjs', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error('[runtime] pack-runtime failed:', e.message);
    process.exit(1);
  }

  const tauriConfig = join(desktopDir, 'tauri.conf.json');
  const tauriBin = join(ROOT, 'node_modules', '.bin', 'tauri');
  const r = spawnSync(tauriBin, ['build', '--config', tauriConfig, ...forward], {
    cwd: desktopDir,
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });

  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }

  if (r.status === 0 && process.platform === 'darwin') {
    patchDmgExtras(ROOT);
  }

  process.exit(r.status ?? 1);
}

// Find all .dmg files under target/ and inject the helper TXT files
// (quarantine removal instructions) into each one.
function patchDmgExtras(root) {
  const patchScript = join(root, 'scripts', 'patch-dmg-extras.sh');
  const targetDir = join(root, 'target');

  const dmgFiles = findDmgFiles(targetDir);
  if (dmgFiles.length === 0) {
    console.log('[patch-dmg] No .dmg files found — skipping.');
    return;
  }

  for (const dmg of dmgFiles) {
    console.log(`[patch-dmg] Patching ${dmg}`);
    const p = spawnSync('bash', [patchScript, dmg], {
      stdio: 'inherit',
      shell: false,
    });
    if (p.status !== 0) {
      console.error(`[patch-dmg] Failed to patch ${dmg}`);
      process.exit(1);
    }
  }
}

function findDmgFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findDmgFiles(full));
      } else if (entry.name.endsWith('.dmg')) {
        results.push(full);
      }
    }
  } catch {
    // directory may not exist for some targets
  }
  return results;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

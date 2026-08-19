#!/usr/bin/env node
/**
 * Runs `tauri build` from src/apps/desktop with CI=true.
 * On Windows: shared OpenSSL bootstrap (see ensure-openssl-windows.mjs).
 */
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { readdirSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync, createReadStream } from 'fs';
import { createHash } from 'crypto';
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
  // Release packaging must not touch target/release/incremental: the dir can
  // get locked by AV/indexer handles (os error 5) and offers no benefit for
  // reproducible installer builds.
  process.env.CARGO_INCREMENTAL = '0';

  // Assemble locally-built runtime DLLs into target/release/runtime/, then
  // pack them into dist/runtime-*.zip for the first-run download channel
  // (the installer no longer bundles the runtime — split-installer design).
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

  console.log('[runtime] Collecting runtime DLLs + packing runtime zip...');
  try {
    execSync('node scripts/pack-runtime.mjs --pack-zip', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error('[runtime] pack-runtime failed:', e.message);
    process.exit(1);
  }

  const tauriConfig = join(desktopDir, 'tauri.conf.json');
  const updaterConfig = join(desktopDir, 'tauri.updater.json');
  const tauriBin = join(ROOT, 'node_modules', '.bin', 'tauri');
  // Updater artifacts (signed *.nsis.zip + .sig) require the signing key.
  // CI injects TAURI_SIGNING_PRIVATE_KEY as a secret; locally fall back to
  // the generated key at .tauri/ai00-updater.key (gitignored). Without a
  // key the updater config is skipped so unsigned builds still succeed.
  // NOTE: do NOT default the password env to '' — an empty string is
  // treated as a real (wrong) password by the signer; unset means none.
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === '') {
    delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    const localKey = join(ROOT, '.tauri', 'ai00-updater.key');
    const localPwd = join(ROOT, '.tauri', 'ai00-updater.key.password');
    if (existsSync(localKey)) {
      process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(localKey, 'utf-8');
      // The local key is generated WITH a password (stored next to it,
      // gitignored) — the tauri signer rejects no-password and empty-string
      // variants inconsistently, so a real password is the reliable path.
      if (existsSync(localPwd)) {
        process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(localPwd, 'utf-8').trim();
      }
    }
  }
  const configArgs = ['--config', tauriConfig];
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    configArgs.push('--config', updaterConfig);
  } else {
    console.warn('[updater] no signing key — skipping updater artifacts (latest.json will be omitted)');
  }
  const r = spawnSync(tauriBin, ['build', ...configArgs, ...forward], {
    cwd: desktopDir,
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });

  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }

  if (r.status === 0) {
    await buildResourceArtifacts();
    if (process.platform === 'darwin') {
      patchDmgExtras(ROOT);
    }
  }

  process.exit(r.status ?? 1);
}

// ── split-installer resource artifacts ─────────────────────────────
// The installer ships only exe + loader.zip; main.zip / underlay.zip /
// sounds.zip / runtime-*.zip are published as release assets and fetched on
// first run via dist/resources-manifest-<os>-<arch>.json (content-addressed
// by sha256). The manifest and updater latest.json are suffixed with the
// platform because release assets share one flat namespace.

// Tauri-style platform id: windows-x86_64 / linux-x86_64 / darwin-aarch64 …
// (matches std::env::consts::{OS, ARCH} used by resource_manager.rs).
function platformId() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${os}-${arch}`;
}

function findBundleDir(root) {
  const candidates = [
    join(root, 'target', 'release', 'bundle'),
    join(root, 'src', 'apps', 'desktop', 'target', 'release', 'bundle'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// Locate the updater artifact pair for this platform:
// { assetPath, sigPath } — Windows: nsis/*-setup.exe, Linux: appimage/*.AppImage,
// macOS: macos/*.app.tar.gz. Sig sits next to the asset (+ '.sig').
function findUpdaterAsset(bundleDir) {
  const subdirs = {
    win32: 'nsis',
    linux: 'appimage',
    darwin: 'macos',
  };
  const sub = subdirs[process.platform];
  if (!sub) return null;
  const dir = join(bundleDir, sub);
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir).filter((f) => {
    if (process.platform === 'win32') return /-setup\.exe$/.test(f);
    if (process.platform === 'linux') return f.endsWith('.AppImage');
    return f.endsWith('.app.tar.gz');
  });
  if (files.length === 0) return null;

  const asset = join(dir, files[0]);
  const sig = `${asset}.sig`;
  return existsSync(sig) ? { assetPath: asset, sigPath: sig } : null;
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function zipDir(src, dest) {
  const r = spawnSync(process.execPath, [join(__dirname, 'zip-dir.mjs'), src, dest], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    throw new Error(`zip-dir failed for ${dest} (${r.error ? r.error.message : `exit ${r.status}`})`);
  }
}

async function buildResourceArtifacts() {
  try {
    const dist = join(ROOT, 'dist');
    mkdirSync(dist, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

    // 1. sounds → dist/sounds.zip (was bundled with the exe before the split)
    const soundsSrc = join(ROOT, 'src', 'apps', 'desktop', 'sounds');
    if (existsSync(soundsSrc)) {
      zipDir(soundsSrc, join(dist, 'sounds.zip'));
      console.log('[resources] packed sounds.zip');
    }

    // 2. locate the runtime zip produced by pack-runtime --pack-zip
    const runtimeZip = readdirSync(dist).find((f) => /^runtime-.*\.zip$/.test(f));
    if (!runtimeZip) {
      console.warn('[resources] runtime-*.zip not found — manifest will omit the runtime entry');
    }

    // 3. build the content-addressed manifest (per-platform filename)
    const entries = [
      { key: 'main', file: 'main.zip', kind: 'zip', version: pkg.version },
      { key: 'underlay', file: 'underlay.zip', kind: 'zip', version: pkg.version },
    ];
    if (existsSync(join(dist, 'sounds.zip'))) {
      entries.push({ key: 'sounds', file: 'sounds.zip', kind: 'extract:sounds', version: pkg.version });
    }
    if (runtimeZip) {
      entries.push({
        key: 'runtime',
        file: runtimeZip,
        kind: 'extract:runtime',
        version: runtimeZip.replace(/^runtime-/, '').replace(/\.zip$/, ''),
      });
    }

    // P2P: with AI00_X_TRACKER_URL set, build a .torrent + magnet per zip so
    // clients can fetch/seed via BitTorrent alongside the HTTP mirrors. The
    // magnet lands in the manifest (ResourceEntry.magnet, optional); without
    // the env var everything stays HTTP-only (field omitted).
    const trackerUrl = process.env.AI00_X_TRACKER_URL?.trim();
    const magnets = {};
    if (trackerUrl) {
      for (const e of entries) {
        const zipPath = join(dist, e.file);
        if (!existsSync(zipPath)) continue;
        const r = spawnSync(
          process.execPath,
          [join(__dirname, 'make-torrent.mjs'), zipPath, trackerUrl],
          { encoding: 'utf8' },
        );
        if (r.error || r.status !== 0) {
          console.warn(`[resources] make-torrent failed for ${e.file}: ${r.stderr || r.error?.message}`);
          continue;
        }
        const { infoHash, magnet } = JSON.parse(r.stdout.trim().split('\n').pop());
        magnets[e.file] = magnet;
        console.log(`[resources] torrent ${e.file}: ${infoHash}`);
      }
    } else {
      console.log('[resources] AI00_X_TRACKER_URL not set — skipping P2P torrents');
    }

    const resources = {};
    for (const e of entries) {
      const p = join(dist, e.file);
      if (!existsSync(p)) {
        console.warn(`[resources] ${e.file} missing — skipping manifest entry`);
        continue;
      }
      resources[e.key] = {
        file: e.file,
        version: e.version,
        kind: e.kind,
        size: statSync(p).size,
        sha256: await sha256File(p),
        ...(magnets[e.file] ? { magnet: magnets[e.file] } : {}),
      };
    }

    const manifest = {
      manifestVersion: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12),
      resources,
    };
    const manifestPath = join(dist, `resources-manifest-${platformId()}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[resources] wrote ${manifestPath} (${Object.keys(resources).length} entries)`);

    // 4. updater latest-<platform>.json (only when signed artifacts exist)
    await buildUpdaterManifest(dist, pkg);
  } catch (e) {
    console.warn('[resources] artifact build failed:', e.message);
  }
}

// Generate dist/latest-<platform>.json pointing at the signed installer in
// this repo's GitHub release. The tauri.conf.json endpoint uses
// {{target}}-{{arch}} placeholders so each platform fetches its own file.
async function buildUpdaterManifest(dist, pkg) {
  const bundleDir = findBundleDir(ROOT);
  if (!bundleDir) {
    console.warn('[updater] bundle dir not found — skipping latest.json');
    return;
  }
  const asset = findUpdaterAsset(bundleDir);
  if (!asset) {
    console.warn('[updater] signed installer not found — skipping latest.json');
    return;
  }

  const platform = platformId();
  const repo = 'cgisky1980/ai00-x-client';
  const tag = `v${pkg.version}`;
  const assetName = basename(asset.assetPath);
  const signature = readFileSync(asset.sigPath, 'utf-8').trim();

  const latest = {
    version: pkg.version,
    notes: `Release ${tag}`,
    pub_date: new Date().toISOString(),
    platforms: {
      [platform]: {
        signature,
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
      },
    },
  };
  const latestPath = join(dist, `latest-${platform}.json`);
  writeFileSync(latestPath, JSON.stringify(latest, null, 2));
  console.log(`[updater] wrote ${latestPath}`);
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

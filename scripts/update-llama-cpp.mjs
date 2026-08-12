#!/usr/bin/env node
/**
 * update-llama-cpp.mjs
 *
 * Detects the latest stable release tag of ggml-org/llama.cpp, compares it
 * with the pinned version constant, and if a newer release exists, bumps the
 * llama.cpp submodule pointer and the version constants in
 * `downloader.rs` / `pack-runtime.mjs`.
 *
 * Exit codes (used by the GitHub Actions workflow):
 *   0  already up to date (no change made)
 *   2  updated to a newer release (constants + submodule pointer changed)
 *   1  error (network failure, missing files, etc.)
 *
 * Usage:
 *   node scripts/update-llama-cpp.mjs
 *
 * The script is idempotent: running it again after an update reports
 * "already up to date" and exits 0.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const LLAMA_REPO = 'ggml-org/llama.cpp';
const SUBMODULE_DIR = join(ROOT, 'llama.cpp');
const DOWNLOADER = join(ROOT, 'src', 'crates', 'inference', 'src', 'runtime', 'downloader.rs');
const PACK_RUNTIME = join(ROOT, 'scripts', 'pack-runtime.mjs');

function log(msg) {
  console.log(`[update-llama-cpp] ${msg}`);
}

// Read the pinned version from downloader.rs (single source of truth for the
// version constant; pack-runtime.mjs mirrors it).
function getPinnedVersion() {
  const src = readFileSync(DOWNLOADER, 'utf8');
  const m = src.match(/pub const LLAMA_CPP_VERSION: &str = "([bB][0-9]+)"/);
  if (!m) {
    throw new Error(`LLAMA_CPP_VERSION constant not found in ${DOWNLOADER}`);
  }
  return m[1];
}

// Query the GitHub API for the latest stable release tag (e.g. "b10369").
async function getLatestReleaseTag() {
  const url = `https://api.github.com/repos/${LLAMA_REPO}/releases/latest`;
  log(`Fetching latest release from ${url}...`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ai00-x-update-llama-cpp',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const tag = data?.tag_name;
  if (!tag) {
    throw new Error(`GitHub API returned no tag_name for ${LLAMA_REPO}`);
  }
  return tag;
}

// Numeric comparison of llama.cpp tag names of the form "bNNNNN".
function compareTags(a, b) {
  const na = parseInt(a.replace(/^b/i, ''), 10);
  const nb = parseInt(b.replace(/^b/i, ''), 10);
  return na - nb;
}

function bumpConstants(version) {
  // downloader.rs
  let src = readFileSync(DOWNLOADER, 'utf8');
  src = src.replace(
    /pub const LLAMA_CPP_VERSION: &str = "[^"]*"/,
    `pub const LLAMA_CPP_VERSION: &str = "${version}"`
  );
  writeFileSync(DOWNLOADER, src);

  // pack-runtime.mjs
  let pack = readFileSync(PACK_RUNTIME, 'utf8');
  pack = pack.replace(/llama: '[^']*'/, `llama: '${version}'`);
  writeFileSync(PACK_RUNTIME, pack);

  log(`Updated LLAMA_CPP_VERSION to ${version} in:`);
  log(`  - ${DOWNLOADER.replace(ROOT, 'scripts/..').replace(/\\/g, '/')}`);
  log(`  - ${PACK_RUNTIME.replace(ROOT, 'scripts/..').replace(/\\/g, '/')}`);
}

// Point the submodule at the release tag and stage the gitlink change in the
// parent repo so the workflow can commit it. The submodule from
// `actions/checkout` is a shallow clone (only the pinned commit), so the new
// tag must be fetched before checkout.
function bumpSubmodule(tag) {
  log(`Fetching tag ${tag} into submodule...`);
  execSync(`git -C "${SUBMODULE_DIR}" fetch --depth 1 origin tag ${tag}`, { stdio: 'inherit' });
  log(`Checking out submodule at ${tag}...`);
  execSync(`git -C "${SUBMODULE_DIR}" checkout ${tag}`, { stdio: 'inherit' });
  // Stage the submodule pointer change in the parent repository.
  execSync(`git add llama.cpp`, { cwd: ROOT, stdio: 'inherit' });
  log(`Submodule pointer updated to ${tag} and staged.`);
}

async function main() {
  const pinned = getPinnedVersion();
  log(`Pinned version: ${pinned}`);

  const latest = await getLatestReleaseTag();
  log(`Latest stable release: ${latest}`);

  if (compareTags(latest, pinned) <= 0) {
    log(`Already up to date (pinned ${pinned} >= latest ${latest}). No changes made.`);
    process.exit(0);
  }

  log(`Newer release detected: ${pinned} -> ${latest}`);
  bumpConstants(latest);
  bumpSubmodule(latest);
  log(`Done. llama.cpp upgraded from ${pinned} to ${latest}.`);
  process.exit(2);
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
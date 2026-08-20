#!/usr/bin/env node

/**
 * Version sync script — SINGLE SOURCE OF TRUTH: root package.json
 *
 * 所有版本号统一以根目录 `package.json` 的 `version` 字段为唯一来源。
 * 本脚本将其传播到：
 *   1. `Cargo.toml` 的 `[workspace.package] version`（所有 Rust crate 继承）
 *   2. 各子包 `package.json`（web-ui / loader-ui / underlay-ui）
 *   3. 重新生成版本信息文件（version.json / version.ts / version-injection.html）
 *
 * 用法：`pnpm run sync-version`
 * 触发：构建流程（prebuild → generate-all → sync-version）会自动执行。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

function writeJson(rel, obj) {
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(obj, null, 2) + '\n');
}

function main() {
  const rootPkg = readJson('package.json');
  const version = rootPkg.version;

  // 接受 semver prerelease 后缀（如 0.1.1-nightly.20260820，nightly CI 使用）
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`[sync-version] Invalid version in package.json: "${version}"`);
    process.exit(1);
  }

  // 1. Sync Cargo.toml [workspace.package] version
  const cargoPath = path.join(ROOT, 'Cargo.toml');
  const cargo = fs.readFileSync(cargoPath, 'utf-8');
  const cargoVersionRe = /(version\s*=\s*)"[^"]*"(\s*#\s*x-release-please-version)/;
  if (!cargoVersionRe.test(cargo)) {
    console.warn('[sync-version] Cargo.toml: workspace version pattern not found (expected `version = "x.y.z" # x-release-please-version`)');
  } else {
    const nextCargo = cargo.replace(cargoVersionRe, `$1"${version}"$2`);
    if (nextCargo !== cargo) {
      fs.writeFileSync(cargoPath, nextCargo);
      console.log(`[sync-version] Cargo.toml -> ${version}`);
    }
  }

  // 2. Sync nested package.json (private, bundled with the app)
  const nested = [
    'src/web-ui/package.json',
    'src/loader-ui/package.json',
    'src/underlay-ui/package.json',
  ];
  for (const rel of nested) {
    const pkg = readJson(rel);
    if (pkg.version !== version) {
      pkg.version = version;
      writeJson(rel, pkg);
      console.log(`[sync-version] ${rel} -> ${version}`);
    }
  }

  // 3. Regenerate version info files
  execSync('node scripts/generate-version.cjs', { cwd: ROOT, stdio: 'inherit' });

  console.log(`[sync-version] Done. All versions unified to ${version}.`);
}

main();
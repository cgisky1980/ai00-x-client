#!/usr/bin/env node
/**
 * 同步共享地图数据到各前端包（loader-ui / web-ui）的 public/data。
 *
 * 地图数据唯一来源：packages/shared/assets/location/
 * 各包构建/运行时从自己的 public/data 读取（vite 以 /data/... 提供）。
 *
 * 用法：node scripts/sync-location-assets.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SRC = path.join(root, 'packages', 'shared', 'assets', 'location');
const TARGETS = [
  path.join(root, 'src', 'loader-ui', 'public', 'data'),
  path.join(root, 'src', 'web-ui', 'public', 'data'),
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`[sync-location-assets] source not found: ${SRC}`);
  process.exit(1);
}

for (const target of TARGETS) {
  copyDir(SRC, target);
  console.log(`[sync-location-assets] synced -> ${path.relative(root, target)}`);
}
console.log('[sync-location-assets] done');
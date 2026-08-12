#!/usr/bin/env node
/**
 * zip-dir.mjs
 *
 * Cross-platform directory → zip archiver.
 *
 * Windows uses PowerShell's Compress-Archive; Linux/macOS use the system `zip`
 * command (present on GitHub-hosted runners and most distros). This replaces
 * the previous PowerShell-only packing that broke on non-Windows runners,
 * which caused `dist/main.zip` / `dist/underlay.zip` to go missing and made
 * tauri-build's `resources` validation fail with "resource path doesn't exist".
 *
 * Usage: node scripts/zip-dir.mjs <srcDir> <destZip>
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: node scripts/zip-dir.mjs <srcDir> <destZip>');
  process.exit(1);
}

const absSrc = resolve(src);
const absDest = resolve(dest);

if (!existsSync(absSrc)) {
  console.error(`zip-dir: source dir not found: ${absSrc}`);
  process.exit(0);
}

let result;
if (process.platform === 'win32') {
  result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${absSrc.replace(/'/g, "''")}/*' -DestinationPath '${absDest.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' }
  );
} else {
  result = spawnSync('bash', ['-c', `cd '${absSrc}' && zip -r -q '${absDest}' .`], { stdio: 'inherit' });
}

if (result.error) {
  console.error(`zip-dir: failed to run archiver: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`zip-dir: archiver exited ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log(`zip-dir: packed ${absSrc} -> ${absDest}`);

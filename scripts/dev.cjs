#!/usr/bin/env node

/**
 * Development environment startup script
 * Manages pre-build tasks and dev server startup
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  printHeader,
  printSuccess,
  printInfo,
  printError,
  printStep,
  printComplete,
  printBlank,
} = require('./console-style.cjs');

const ROOT_DIR = path.resolve(__dirname, '..');

// 本地端口唯一来源：packages/shared/server-endpoints.json（与 Rust/TS 由同一脚本生成）
const localPorts = require(path.join(ROOT_DIR, 'packages/shared/server-endpoints.json')).localPorts;

/**
 * Run command synchronously (silent mode)
 */
function runSilent(command, cwd = ROOT_DIR) {
  try {
    const stdout = execSync(command, { 
      cwd, 
      stdio: 'pipe',
      encoding: 'buffer'
    });
    return { ok: true, stdout: decodeOutput(stdout), stderr: '' };
  } catch (error) {
    const stdout = error.stdout ? decodeOutput(error.stdout) : '';
    const stderr = error.stderr ? decodeOutput(error.stderr) : '';
    return { ok: false, stdout, stderr, error };
  }
}

function decodeOutput(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
  if (process.platform !== 'win32') return buffer.toString('utf-8');

  const utf8 = buffer.toString('utf-8');
  if (!utf8.includes('�')) return utf8;

  try {
    const { TextDecoder } = require('util');
    const decoder = new TextDecoder('gbk');
    const gbk = decoder.decode(buffer);
    if (gbk && !gbk.includes('�')) return gbk;
    return gbk || utf8;
  } catch (error) {
    return utf8;
  }
}

function tailOutput(output, maxLines = 12) {
  if (!output) return '';
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-maxLines).join('\n');
}

/**
 * Run command with inherited output
 */
function runInherit(command, cwd = ROOT_DIR) {
  try {
    execSync(command, { cwd, stdio: 'inherit' });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Run command and show output
 */
function runCommand(command, cwd = ROOT_DIR) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];
    
    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: 'inherit'
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    child.on('error', reject);
  });
}

/**
 * Spawn a command with explicit args array (no shell interpolation, safe for paths with spaces)
 */
function spawnCommand(cmd, args, cwd = ROOT_DIR) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Main entry
 */
async function main() {
  const startTime = Date.now();
  const mode = process.argv[2] || 'web'; // web | desktop
  const modeLabel = mode === 'desktop' ? 'Desktop' : 'Web';
  
  printHeader(`Ai00-X ${modeLabel} Development`);
  printBlank();

  const totalSteps = mode === 'desktop' ? 4 : 3;

  // Step 1: Copy resources
  printStep(1, totalSteps, 'Copy resources');
  const copyResult = runSilent('pnpm run copy-monaco --silent');
  if (copyResult.ok) {
    printSuccess('Monaco Editor resources ready');
  } else {
    printError('Copy resources failed');
    const output = tailOutput(copyResult.stderr || copyResult.stdout);
    if (output) {
      printError(output);
    } else if (copyResult.error) {
      printError(copyResult.error.message);
    }
    if (copyResult.error && copyResult.error.status !== undefined) {
      printError(`Exit code: ${copyResult.error.status}`);
    }
    printInfo('Hint: run `pnpm install` in repo root if dependencies are missing');
    process.exit(1);
  }
  
  // Step 2: Generate version info
  printStep(2, totalSteps, 'Generate version info');
  const versionResult = runInherit('node scripts/generate-version.cjs');
  if (!versionResult.ok) {
    printError('Generate version info failed');
    if (versionResult.error && versionResult.error.message) {
      printError(versionResult.error.message);
    }
    if (versionResult.error && versionResult.error.status !== undefined) {
      printError(`Exit code: ${versionResult.error.status}`);
    }
    process.exit(1);
  }
  
  const prepTime = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // Step 3: Build underlay-ui
  if (mode === 'desktop') {
    printStep(3, 4, 'Build underlay-ui');
    const underlayResult = runSilent('pnpm --dir src/underlay-ui build');
    if (underlayResult.ok) {
      printSuccess('Underlay UI built');
    } else {
      printError('Underlay UI build failed (non-fatal, continuing...)');
      const output = tailOutput(underlayResult.stderr || underlayResult.stdout);
      if (output) printError(output);
    }
  }

  // Final step: Start dev server
  printStep(totalSteps, totalSteps, 'Start dev server');
  printInfo(`Prep took ${prepTime}s`);
  
  printComplete('Initialization complete');
  
  try {
    if (mode === 'desktop') {
      if (process.platform === 'win32') {
        printInfo('Windows: ensuring prebuilt OpenSSL (cached under .ai00-x/cache/)');
        try {
          const { ensureOpenSslWindows } = await import(
            pathToFileURL(path.join(__dirname, 'ensure-openssl-windows.mjs')).href
          );
          await ensureOpenSslWindows();
        } catch (error) {
          printError('OpenSSL bootstrap failed');
          printError(error.message || String(error));
          process.exit(1);
        }
      }
      const desktopDir = path.join(ROOT_DIR, 'src/apps/desktop');
      const tauriConfig = path.join(desktopDir, 'tauri.conf.json');
      const tauriBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tauri');
      // Was previously set via cross-env-shell (broken by cross-env v10).
      process.env['CARGO_INCREMENTAL'] = process.env['CARGO_INCREMENTAL'] || '0';
      process.env['AI00_X_OPEN_DEVTOOLS'] = '1';
      process.env['AI00_X_DEV_MODE'] = '1';
      // Point models/runtime to a directory outside target so they survive cargo clean
      process.env['AI00X_MODELS_DIR'] = path.join(ROOT_DIR, '.ai00-x-dev', 'models');
      process.env['AI00X_RUNTIME_DIR'] = path.join(ROOT_DIR, '.ai00-x-dev', 'runtime');

      printInfo(`Starting web-ui Vite dev server (port ${localPorts.webUiDev})...`);
      const webUiDir = path.join(ROOT_DIR, 'src/web-ui');
      const webUiChild = spawn('npx', ['pnpm', 'exec', 'vite', '--port', String(localPorts.webUiDev)], {
        cwd: webUiDir,
        stdio: 'pipe',
        shell: true,
      });
      webUiChild.stdout?.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) printInfo(`[web-ui] ${msg}`);
      });
      webUiChild.stderr?.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) printInfo(`[web-ui] ${msg}`);
      });

      // Start underlay-ui Vite dev server
      printInfo(`Starting underlay-ui Vite dev server (port ${localPorts.underlayDev})...`);
      const underlayUiDir = path.join(ROOT_DIR, 'src/underlay-ui');
      const underlayChild = spawn('npx', ['pnpm', 'exec', 'vite', '--port', String(localPorts.underlayDev)], {
        cwd: underlayUiDir,
        stdio: 'pipe',
        shell: true,
      });
      underlayChild.stdout?.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) printInfo(`[underlay-ui] ${msg}`);
      });
      underlayChild.stderr?.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) printInfo(`[underlay-ui] ${msg}`);
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));
      printSuccess('web-ui Vite dev server started');
      printSuccess('underlay-ui Vite dev server started');

      await spawnCommand(tauriBin, ['dev', '--config', tauriConfig, '--release'], desktopDir);
    } else {
      await runCommand('pnpm exec vite', path.join(ROOT_DIR, 'src/web-ui'));
    }
  } catch (error) {
    printError('Dev server failed to start');
    process.exit(1);
  }
}

main().catch((error) => {
  printError('Startup failed: ' + error.message);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Server endpoints generator — SINGLE SOURCE OF TRUTH: packages/shared/server-endpoints.json
 *
 * 所有服务器地址（生产 + 本地）统一以 `packages/shared/server-endpoints.json` 为唯一来源。
 * 本脚本从该 JSON 生成：
 *   1. Rust 侧：`src/crates/core/src/service/config/server_endpoints.rs`
 *   2. TS 侧：`packages/shared/src/serverEndpoints.ts`
 *   3. 更新 `src/apps/desktop/tauri.conf.json` 中的 devUrl / overlay 端口
 *
 * 生产地址以 XOR 混淆字节存储、运行时解码，避免源码明文暴露生产服务器地址。
 * 本地端口为明文常量（回环地址无保密需求）。
 *
 * 用法：`pnpm run generate-endpoints`
 * 触发：构建流程（prebuild → generate-all → sync-version,endpoints）会自动执行。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_SRC = path.join(ROOT, 'packages/shared/server-endpoints.json');
const RUST_OUT = path.join(ROOT, 'src/crates/core/src/service/config/server_endpoints.rs');
const TS_OUT = path.join(ROOT, 'packages/shared/src/serverEndpoints.ts');
const TAURI_CONF = path.join(ROOT, 'src/apps/desktop/tauri.conf.json');

/** 将数字数组格式化为多行缩进的 Rust 数组字面量 */
function formatRustArray(encoded) {
  const perLine = 8;
  const lines = [];
  for (let i = 0; i < encoded.length; i += perLine) {
    lines.push('        ' + encoded.slice(i, i + perLine).join(', '));
  }
  return lines.join(',\n');
}

/** 将数字数组格式化为多行缩进的 TS 数组字面量 */
function formatTsArray(encoded) {
  const perLine = 8;
  const lines = [];
  for (let i = 0; i < encoded.length; i += perLine) {
    lines.push('  ' + encoded.slice(i, i + perLine).join(', '));
  }
  return lines.join(',\n');
}

/** 基础地址导出名保持既有约定，其余用大写蛇形（如 AI00_S_RELAY_URL） */
function tsConstantName(name) {
  if (name === 'ai00_s_base_url') return 'DEFAULT_AI00_S_BASE_URL';
  return name.split('_').map((s) => s.toUpperCase()).join('_');
}

/** 本地端口 JSON 键 → Rust 常量名（如 webUiDev → LOCAL_WEB_UI_DEV_PORT） */
function rustPortConst(key) {
  return 'LOCAL_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() + '_PORT';
}

/** 本地端口 JSON 键 → TS 常量名（如 webUiDev → WEB_UI_DEV_PORT） */
function tsPortConst(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() + '_PORT';
}

/** 更新 tauri.conf.json 中的 devUrl / overlay 端口（正则替换，保留其余格式） */
function updateTauriConf(localPorts) {
  let conf = fs.readFileSync(TAURI_CONF, 'utf-8');
  const before = conf;
  conf = conf.replace(
    /("devUrl":\s*"http:\/\/localhost:)\d+(")/,
    `$1${localPorts.loaderDev}$2`
  );
  conf = conf.replace(
    /("url":\s*"http:\/\/localhost:)\d+(\/main\/")/,
    `$1${localPorts.embeddedServer}$2`
  );
  if (conf !== before) {
    fs.writeFileSync(TAURI_CONF, conf);
    console.log(`[generate-endpoints] Updated ${TAURI_CONF}`);
  }
}

function main() {
  const data = JSON.parse(fs.readFileSync(JSON_SRC, 'utf-8'));
  const xorKey = data.xorKey;
  const endpoints = data.endpoints;
  const localHost = data.localHost;
  const localPorts = data.localPorts;

  // ---- Generate Rust ----
  const rustFn = [];
  for (const [name, ep] of Object.entries(endpoints)) {
    rustFn.push(`/// ${ep.comment}（生产域名，XOR 混淆存储）`);
    rustFn.push(`pub fn ${name}() -> String {`);
    rustFn.push(`    decode_xor(&[`);
    rustFn.push(formatRustArray(ep.encoded));
    rustFn.push(`    ])`);
    rustFn.push(`}`);
    rustFn.push('');
  }

  const rustPorts = [];
  rustPorts.push(`/// 本地服务器主机（回环地址，禁止外部访问）`);
  rustPorts.push(`pub const LOCAL_HOST: &str = "${localHost}";`);
  rustPorts.push('');
  for (const [key, port] of Object.entries(localPorts)) {
    rustPorts.push(`pub const ${rustPortConst(key)}: u16 = ${port};`);
  }
  rustPorts.push('');
  rustPorts.push(`/// 本地前端服务器 origin（dev 模式用 web-ui dev 端口，否则用生产内嵌端口）`);
  rustPorts.push(`pub fn local_web_origin() -> String {`);
  rustPorts.push(`    if std::env::var("AI00_X_DEV_MODE").is_ok() {`);
  rustPorts.push(`        format!("http://{}:{}", LOCAL_HOST, LOCAL_WEB_UI_DEV_PORT)`);
  rustPorts.push(`    } else {`);
  rustPorts.push(`        format!("http://{}:{}", LOCAL_HOST, LOCAL_EMBEDDED_SERVER_PORT)`);
  rustPorts.push(`    }`);
  rustPorts.push(`}`);

  const rust = `//! 服务器地址（唯一来源）
//!
//! 由 \`scripts/generate-endpoints.cjs\` 从 \`packages/shared/server-endpoints.json\` 自动生成。
//! 禁止手动修改本文件；修改地址请编辑 JSON 源文件后运行 \`pnpm run generate-endpoints\`。
//! 前端 TS 侧对应 \`packages/shared/src/serverEndpoints.ts\`（\`@ai00-x/shared\`）。
//!
//! 生产地址以 XOR 混淆字节存储，运行时解码，避免源码明文暴露生产服务器地址。
//! 混淆仅用于防爬虫/普通阅读者扫描，非安全加密（密钥与密文同在源码中）。
//! 本地端口为回环地址常量，无保密需求。

/// XOR 混淆密钥
const XOR_KEY: u8 = ${xorKey};

/// 解码 XOR 混淆的字节串
fn decode_xor(encoded: &[u8]) -> String {
    encoded.iter().map(|&b| (b ^ XOR_KEY) as char).collect()
}

${rustFn.join('\n')}${rustPorts.join('\n')}`;

  // ---- Generate TS ----
  const tsConsts = [];
  for (const [name, ep] of Object.entries(endpoints)) {
    const tsName = tsConstantName(name);
    tsConsts.push(`/** ${ep.comment}（生产域名，XOR 混淆存储） */`);
    tsConsts.push(`export const ${tsName} = decodeXor([`);
    tsConsts.push(formatTsArray(ep.encoded));
    tsConsts.push(`])`);
    tsConsts.push('');
  }

  tsConsts.push(`/** 本地服务器主机（回环地址，禁止外部访问） */`);
  tsConsts.push(`export const LOCAL_HOST = '${localHost}'`);
  tsConsts.push('');
  for (const [key, port] of Object.entries(localPorts)) {
    tsConsts.push(`export const ${tsPortConst(key)} = ${port}`);
  }
  tsConsts.push('');

  const ts = `/**
 * 服务器地址（唯一来源）
 *
 * 由 \`scripts/generate-endpoints.cjs\` 从 \`packages/shared/server-endpoints.json\` 自动生成。
 * 禁止手动修改本文件；修改地址请编辑 JSON 源文件后运行 \`pnpm run generate-endpoints\`。
 * 所有前端包（web-ui / loader-ui / underlay-ui）统一从这里导入，禁止各自硬编码。
 * 运行时真实地址从 Rust 后端 \`get_ai00_s_base_url\` 读取，此常量仅作为开发环境的兜底值。
 *
 * 生产地址以 XOR 混淆字节存储，运行时解码，避免源码明文暴露生产服务器地址。
 * 混淆仅用于防爬虫/普通阅读者扫描，非安全加密（密钥与密文同在源码中）。
 * 本地端口为回环地址常量，无保密需求。
 */

const XOR_KEY = ${xorKey}

/** XOR 混淆解码 */
const decodeXor = (encoded: number[]): string =>
  encoded.map((b) => String.fromCharCode(b ^ XOR_KEY)).join('')

${tsConsts.join('\n')}`;

  fs.writeFileSync(RUST_OUT, rust);
  fs.writeFileSync(TS_OUT, ts);
  updateTauriConf(localPorts);
  console.log(`[generate-endpoints] Wrote ${RUST_OUT}`);
  console.log(`[generate-endpoints] Wrote ${TS_OUT}`);
  console.log(`[generate-endpoints] Done. ${Object.keys(endpoints).length} endpoints, ${Object.keys(localPorts).length} local ports.`);
}

main();
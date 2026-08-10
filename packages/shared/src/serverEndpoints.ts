/**
 * 服务器地址（唯一来源）
 *
 * 由 `scripts/generate-endpoints.cjs` 从 `packages/shared/server-endpoints.json` 自动生成。
 * 禁止手动修改本文件；修改地址请编辑 JSON 源文件后运行 `pnpm run generate-endpoints`。
 * 所有前端包（web-ui / loader-ui / underlay-ui）统一从这里导入，禁止各自硬编码。
 * 运行时真实地址从 Rust 后端 `get_ai00_s_base_url` 读取，此常量仅作为开发环境的兜底值。
 *
 * 生产地址以 XOR 混淆字节存储，运行时解码，避免源码明文暴露生产服务器地址。
 * 混淆仅用于防爬虫/普通阅读者扫描，非安全加密（密钥与密文同在源码中）。
 * 本地端口为回环地址常量，无保密需求。
 */

const XOR_KEY = 90

/** XOR 混淆解码 */
const decodeXor = (encoded: number[]): string =>
  encoded.map((b) => String.fromCharCode(b ^ XOR_KEY)).join('')

/** 主后端 Ai00-Salvo 基地址（生产域名，XOR 混淆存储） */
export const DEFAULT_AI00_S_BASE_URL = decodeXor([
  50, 46, 46, 42, 41, 96, 117, 117,
  59, 51, 106, 106, 119, 34, 116, 57,
  53, 55
])

/** 远程连接中继地址（位于主服务器根目录 /ai00-s/relay/*）（生产域名，XOR 混淆存储） */
export const AI00_S_RELAY_URL = decodeXor([
  50, 46, 46, 42, 41, 96, 117, 117,
  59, 51, 106, 106, 119, 34, 116, 57,
  53, 55
])

/** 移动端 web 应用地址（生产域名，XOR 混淆存储） */
export const AI00_S_WEB_APP_URL = decodeXor([
  50, 46, 46, 42, 41, 96, 117, 117,
  59, 51, 106, 106, 119, 34, 116, 57,
  53, 55
])

/** 搜索服务（searxng）地址（生产域名，XOR 混淆存储） */
export const SEARXNG_URL = decodeXor([
  50, 46, 46, 42, 41, 96, 117, 117,
  41, 116, 59, 51, 106, 106, 119, 34,
  116, 57, 53, 55
])

/** 本地服务器主机（回环地址，禁止外部访问） */
export const LOCAL_HOST = '127.0.0.1'

export const WEB_UI_DEV_PORT = 1422
export const WEB_UI_HMR_PORT = 1421
export const LOADER_DEV_PORT = 1423
export const UNDERLAY_DEV_PORT = 1424
export const EMBEDDED_SERVER_PORT = 2100
export const AI00_SALVO_PORT = 8081

/**
 * AI 服务器地址与本地端口配置
 *
 * 与 Rust 端 `ai00_x_core::service::config::server_endpoints` 保持一致。
 * 唯一定义点在 `@ai00-x/shared`，前端所有 fallback 统一从这里引用，修改地址/端口只需改一处。
 */
export {
  DEFAULT_AI00_S_BASE_URL,
  AI00_S_RELAY_URL,
  AI00_S_WEB_APP_URL,
  SEARXNG_URL,
  LOCAL_HOST,
  WEB_UI_DEV_PORT,
  LOADER_DEV_PORT,
  UNDERLAY_DEV_PORT,
  EMBEDDED_SERVER_PORT,
  AI00_SALVO_PORT,
} from '@ai00-x/shared'
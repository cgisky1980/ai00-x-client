//! 服务器地址（唯一来源）
//!
//! 由 `scripts/generate-endpoints.cjs` 从 `packages/shared/server-endpoints.json` 自动生成。
//! 禁止手动修改本文件；修改地址请编辑 JSON 源文件后运行 `pnpm run generate-endpoints`。
//! 前端 TS 侧对应 `packages/shared/src/serverEndpoints.ts`（`@ai00-x/shared`）。
//!
//! 生产地址以 XOR 混淆字节存储，运行时解码，避免源码明文暴露生产服务器地址。
//! 混淆仅用于防爬虫/普通阅读者扫描，非安全加密（密钥与密文同在源码中）。
//! 本地端口为回环地址常量，无保密需求。

/// XOR 混淆密钥
const XOR_KEY: u8 = 90;

/// 解码 XOR 混淆的字节串
fn decode_xor(encoded: &[u8]) -> String {
    encoded.iter().map(|&b| (b ^ XOR_KEY) as char).collect()
}

/// 主后端 Ai00-Salvo 基地址（生产域名，XOR 混淆存储）
pub fn ai00_s_base_url() -> String {
    decode_xor(&[
        50, 46, 46, 42, 41, 96, 117, 117,
        59, 51, 106, 106, 119, 34, 116, 57,
        53, 55
    ])
}

/// 远程连接中继地址（位于主服务器根目录 /ai00-s/relay/*）（生产域名，XOR 混淆存储）
pub fn ai00_s_relay_url() -> String {
    decode_xor(&[
        50, 46, 46, 42, 41, 96, 117, 117,
        59, 51, 106, 106, 119, 34, 116, 57,
        53, 55
    ])
}

/// 移动端 web 应用地址（生产域名，XOR 混淆存储）
pub fn ai00_s_web_app_url() -> String {
    decode_xor(&[
        50, 46, 46, 42, 41, 96, 117, 117,
        59, 51, 106, 106, 119, 34, 116, 57,
        53, 55
    ])
}

/// 搜索服务（searxng）地址（生产域名，XOR 混淆存储）
pub fn searxng_url() -> String {
    decode_xor(&[
        50, 46, 46, 42, 41, 96, 117, 117,
        41, 116, 59, 51, 106, 106, 119, 34,
        116, 57, 53, 55
    ])
}
/// 本地服务器主机（回环地址，禁止外部访问）
pub const LOCAL_HOST: &str = "127.0.0.1";

pub const LOCAL_WEB_UI_DEV_PORT: u16 = 1422;
pub const LOCAL_WEB_UI_HMR_PORT: u16 = 1421;
pub const LOCAL_LOADER_DEV_PORT: u16 = 1423;
pub const LOCAL_UNDERLAY_DEV_PORT: u16 = 1424;
pub const LOCAL_EMBEDDED_SERVER_PORT: u16 = 2100;
pub const LOCAL_AI00_SALVO_PORT: u16 = 8081;

/// 本地前端服务器 origin（dev 模式用 web-ui dev 端口，否则用生产内嵌端口）
pub fn local_web_origin() -> String {
    if std::env::var("AI00_X_DEV_MODE").is_ok() {
        format!("http://{}:{}", LOCAL_HOST, LOCAL_WEB_UI_DEV_PORT)
    } else {
        format!("http://{}:{}", LOCAL_HOST, LOCAL_EMBEDDED_SERVER_PORT)
    }
}
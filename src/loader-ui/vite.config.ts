import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// 本地端口唯一来源：packages/shared/server-endpoints.json（与 Rust/TS 由同一脚本生成）
const { localPorts } = require("../../packages/shared/server-endpoints.json");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ai00-x/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: localPorts.loaderDev,
    strictPort: true,
    // 显式绑定 IPv4 127.0.0.1：Vite 默认绑 localhost(::1)，而 Tauri WebView2 解析
    // localhost 到 127.0.0.1 会导致 loader 窗口"localhost 拒绝连接"。
    host: "127.0.0.1",
    proxy: {
      // 会员 API → Salvo（重写 Origin 绕过 CSRF 白名单）
      '/ai00-s': {
        target: `http://localhost:${localPorts.ai00Salvo}`,
        changeOrigin: true,
        headers: {
          Origin: 'http://localhost:3000',
        },
      },
      // pet 资源 → Salvo（manifest.json/config.json/parts/...）
      '/pet': {
        target: `http://localhost:${localPorts.ai00Salvo}`,
        changeOrigin: true,
        headers: {
          Origin: 'http://localhost:3000',
        },
      },
      // Rust API → Salvo（access/refresh token + 401 拦截器路径）
      // 注:fetchWithAuth 用绝对 URL,proxy 主要用于配置一致性
      '/api/v1': {
        target: `http://localhost:${localPorts.ai00Salvo}`,
        changeOrigin: true,
        headers: {
          Origin: 'http://localhost:3000',
        },
      },
    },
  },
  build: {
    outDir: "../../dist/loader",
    emptyOutDir: true,
  },
});

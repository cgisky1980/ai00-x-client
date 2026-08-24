import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Ai00-X 官网首页：部署为 ai00-x.com 根（server/sites/default 为 vhost root）。
// ⚠️ emptyOutDir 必须为 false —— sites/default 还承载 admin-applications.html、
//    pet/、ai00-s/、runtime/，清空目录会摧毁线上资产。
// 注意相对层级：src/homepage 上三级才是工作区根（client → ai00-x-dev → server）
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../../../server/sites/default"),
    emptyOutDir: false,
    sourcemap: false,
    // 避免产物哈希名与既有静态文件（pet 等）撞名
    assetsDir: "assets/home",
  },
  server: {
    port: 5190,
    host: "127.0.0.1", // IPv4：Tauri WebView2 兼容（工作区纪律）
    proxy: {
      "/ai00-s": { target: "https://ai00-x.com", changeOrigin: true },
    },
  },
});

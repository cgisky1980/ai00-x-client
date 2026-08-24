import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Ai00-UI 演示站：部署为 ai00-x.com/ui/（server/sites/ai00-x.com 为官网虚拟主机根）
// 注意相对层级：src/ui-kit 上三级才是工作区根（client → ai00-x-dev → server）
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../../../server/sites/ai00-x.com/ui"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5180,
    host: "127.0.0.1", // IPv4：Tauri WebView2 兼容（工作区纪律）
  },
});

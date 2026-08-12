import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// 本地端口唯一来源：packages/shared/server-endpoints.json（与 Rust/TS 由同一脚本生成）
const { localPorts } = require("../../packages/shared/server-endpoints.json");

function resolvePackage(name: string) {
  try {
    return path.dirname(require.resolve(name + "/package.json"));
  } catch {
    return name;
  }
}

export default defineConfig({
  base: "/underlay/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../../dist/underlay"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  resolve: {
    alias: {
      "@underlay": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: { include: ["react", "react-dom"] },
  server: {
    port: localPorts.underlayDev,
    // 显式绑定 IPv4 127.0.0.1：Vite 默认绑 localhost(::1)，而 Tauri WebView2 解析
    // localhost 到 127.0.0.1 会导致窗口"localhost 拒绝连接"。
    host: "127.0.0.1",
    proxy: {
      '/shared': `http://localhost:${localPorts.embeddedServer}`,
      // Ai00-Salvo 后端（config/server.toml: port = 8081），路径前缀 /ai00-s
      '/ai00-s': `http://localhost:${localPorts.ai00Salvo}`,
      // Pet 头像资源：开发模式下代理到本地内嵌服务器(2100) 读取
      // （内嵌服务器带 CORS allow-all + 正确服务 dist/loader/pet；Ai00-Salvo 8081 不负责 /pet）
      '/pet': `http://127.0.0.1:${localPorts.embeddedServer}`,
    },
    fs: {
      allow: ['..'],
    },
  },
  publicDir: 'public',
});

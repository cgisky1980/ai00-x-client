import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createRequire } from "module";
import { versionInjectionPlugin } from "./vite.config.version-plugin";

const require = createRequire(import.meta.url);
// 本地端口唯一来源：packages/shared/server-endpoints.json（与 Rust/TS 由同一脚本生成）
const { localPorts } = require("../../packages/shared/server-endpoints.json");

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const isProduction = mode === 'production' || (command === 'build' && mode !== 'development');
  
  return {
    plugins: [
      react(),
      versionInjectionPlugin()
    ],

    base: '/main/',

    // Path resolution
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@/shared": path.resolve(__dirname, "./src/shared"),
        "@/core": path.resolve(__dirname, "./src/core"),
        "@/tools": path.resolve(__dirname, "./src/tools"),
        "@/hooks": path.resolve(__dirname, "./src/hooks"),
        "@/styles": path.resolve(__dirname, "./src/component-library/styles"),
        "@/types": path.resolve(__dirname, "./src/shared/types"),
        "@/utils": path.resolve(__dirname, "./src/shared/utils"),
        "@components": path.resolve(__dirname, "./src/component-library/components"),
      },
    },

  css: {
    preprocessorOptions: {
      scss: {
        // SCSS preprocessing options (sourcemap is controlled by build.sourcemap)
      },
    },
    // dev mode enabled, release mode disabled
    devSourcemap: !isProduction,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: localPorts.webUiDev,
    // Tauri devUrl is fixed to http://localhost:1422.
    // If Vite silently falls back to another port, the desktop webview stays blank.
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: {
      protocol: "ws",
      host: host || "127.0.0.1",
      port: localPorts.webUiHmr,
    },
    // Dev proxy → Salvo（注:fetchWithAuth 用绝对 URL,proxy 主要用于配置一致性）
    proxy: {
      // 会员 API → Salvo（重写 Origin 绕过 CSRF 白名单）
      '/ai00-s': {
        target: `http://localhost:${localPorts.ai00Salvo}`,
        changeOrigin: true,
        headers: {
          Origin: 'http://localhost:3000',
        },
      },
      // Rust API → Salvo（access/refresh token + 401 拦截器路径）
      '/api/v1': {
        target: `http://localhost:${localPorts.ai00Salvo}`,
        changeOrigin: true,
        headers: {
          Origin: 'http://localhost:3000',
        },
      },
    },
    // Allow access to workspace root for dependencies like monaco-editor
    fs: {
      allow: [
        path.resolve(__dirname, '../../'), // Workspace root
      ],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and `apps`
      ignored: ["**/src-tauri/**", "**/apps/**"],
      // Increase polling interval for stability (especially on Windows)
      usePolling: true,
      interval: 100,
    },
  },

  // Optimize dependency pre-building
  optimizeDeps: {
    // Exclude dependencies that need to be dynamically loaded
    exclude: [],
    // Force pre-building dependencies
    // Resolve Vite 7 and React 18 compatibility issues
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'mermaid',
      'mermaid/dist/mermaid.esm.min.mjs',
    ],
  },

  // Build options
  build: {
    // Enable CSS code splitting
    cssCodeSplit: true,
    // release version disable sourcemap, dev/debug version enable
    sourcemap: !isProduction,
    // Output to the project root directory dist/main/
    outDir: '../../dist/main',
    // Empty the output directory
    emptyOutDir: true,
    // 禁用 modulePreload — 避免初始加载 12.6MB JS 文件
    // 懒加载的 chunk 会在实际使用时才下载
    modulePreload: false,
    // Multi-page application: main app + chat window + preview window
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        chat: path.resolve(__dirname, 'chat.html'),
        preview: path.resolve(__dirname, 'preview.html'),
      },
      // v9 重构：原 webtorrent external 配置已移除。
      // P2P 改用 Tauri 命令调用 Rust fx-torrent，前端不再依赖 webtorrent npm 包。
    },
  }
  };
});

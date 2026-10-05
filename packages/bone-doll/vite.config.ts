import { defineConfig } from 'vite'

// demo/编辑器直接以 assets/ 为 public 根（/skeleton.json、/parts/*.png 免拷贝）
export default defineConfig({
  publicDir: './assets',
})

import { defineConfig } from 'vite'

// demo 直接复用 underlay-ui 的 public 目录（/pet/doll/ 资产免拷贝）
export default defineConfig({
  publicDir: '../../src/underlay-ui/public',
})

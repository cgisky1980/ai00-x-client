import { encodePNG } from './png.mjs'

/** 64×64 级小画布的像素缓冲 + 基础图元（素体生成用，风格 = 硬边像素 + 外描边）。 */
export class PixBuf {
  constructor(w = 64, h = 64) {
    this.w = w
    this.h = h
    this.data = new Uint8Array(w * h * 4)
  }

  /** '#rrggbb' → RGBA 字节 */
  hex(s) {
    const n = parseInt(s.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
  }

  set(x, y, c) {
    x = Math.floor(x)
    y = Math.floor(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.data[i] = c[0]
    this.data[i + 1] = c[1]
    this.data[i + 2] = c[2]
    this.data[i + 3] = c[3]
  }

  isOpaque(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false
    return this.data[(y * this.w + x) * 4 + 3] > 0
  }

  rect(x, y, w, h, c) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c)
  }

  /** 椭圆填充；filter(px,py) 可选裁剪（发际线/半帽等） */
  ellipse(cx, cy, rx, ry, c, filter) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx
        const dy = (y + 0.5 - cy) / ry
        if (dx * dx + dy * dy <= 1 && (!filter || filter(x, y))) this.set(x, y, c)
      }
    }
  }

  /** 对透明像素中 4 邻接不透明者描边（画完形状后调用一次） */
  outline(c) {
    const marks = []
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.isOpaque(x, y)) continue
        if (this.isOpaque(x - 1, y) || this.isOpaque(x + 1, y) || this.isOpaque(x, y - 1) || this.isOpaque(x, y + 1)) {
          marks.push([x, y])
        }
      }
    }
    for (const [x, y] of marks) this.set(x, y, c)
  }

  toPNG() {
    return encodePNG(this.w, this.h, this.data)
  }
}

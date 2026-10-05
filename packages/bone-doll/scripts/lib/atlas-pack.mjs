import { encodePNG } from './png.mjs'

/**
 * 简易 atlas 打包器：图块裁剪 + shelf packing + 页纹理/atlas 文本输出。
 * 专为 64×64 级小部件图设计——单页纹理足够，无旋转、无多页（溢出自动翻倍页高）。
 */

/** 从 RGBA 中裁出 alpha>0 的包围盒子图。空图返回 null。 */
export function trimAlpha(width, height, rgba) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const sub = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((minY + y) * width + (minX + x)) * 4
      const d = (y * w + x) * 4
      sub[d] = rgba[s]
      sub[d + 1] = rgba[s + 1]
      sub[d + 2] = rgba[s + 2]
      sub[d + 3] = rgba[s + 3]
    }
  }
  return { x: minX, y: minY, w, h, rgba: sub }
}

/**
 * shelf packing：按高度降序分行摆放，块间 1px 间隙防渗色。
 * 返回 { pageW, pageH, slots: Map<name, {x, y}> }（图块自身 w/h 由调用方持有）。
 */
export function pack(blocks) {
  // blocks: [{ name, w, h }]
  const sorted = [...blocks].sort((a, b) => b.h - a.h || a.name.localeCompare(b.name))
  let pageW = 64
  let pageH = 64
  // 试装：页宽从 64 翻倍到 1024，页高不够再翻倍
  for (let attempt = 0; attempt < 8; attempt++) {
    const slots = new Map()
    let x = 1
    let y = 1
    let rowH = 0
    let ok = true
    for (const b of sorted) {
      if (b.w + 2 > pageW || b.h + 2 > pageH) {
        ok = false
        break
      }
      if (x + b.w + 1 > pageW) {
        x = 1
        y += rowH + 1
        rowH = 0
      }
      if (y + b.h + 1 > pageH) {
        ok = false
        break
      }
      slots.set(b.name, { x, y })
      x += b.w + 1
      if (b.h > rowH) rowH = b.h
    }
    if (ok) return { pageW, pageH, slots }
    if (pageW < 1024) pageW *= 2
    else pageH *= 2
  }
  throw new Error('atlas-pack: 图块放不进 1024×1024 页（部件图过大？）')
}

/** 粘贴图块到页缓冲 */
export function blit(page, pageW, x, y, w, h, rgba) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const s = (j * w + i) * 4
      const d = ((y + j) * pageW + (x + i)) * 4
      page[d] = rgba[s]
      page[d + 1] = rgba[s + 1]
      page[d + 2] = rgba[s + 2]
      page[d + 3] = rgba[s + 3]
    }
  }
}

/**
 * 生成 Spine 4.x atlas 文本（单页）。
 * bounds = 页内图块位置。
 * ★ 不写 offsets/orig：4.3.7 MeshAttachment.computeUVs 会用 offsets 做偏移减除，
 *   只有 mesh uvs 是「原始整图归一化」时才需要；我们的 mesh uvs 是「trim 内归一化」，
 *   orig 缺省=region 尺寸、offset=0 时 computeUVs 恰为恒等映射。
 */
export function buildAtlasText(pageName, pageW, pageH, regions) {
  // regions: [{ name, bounds:{x,y,w,h} }]
  let out = `\n${pageName}\nsize:${pageW},${pageH}\nfilter:Nearest,Nearest\npma:false\n`
  for (const r of regions) {
    out += `${r.name}\n`
    out += `  bounds: ${r.bounds.x}, ${r.bounds.y}, ${r.bounds.w}, ${r.bounds.h}\n`
  }
  return out
}

export { encodePNG }

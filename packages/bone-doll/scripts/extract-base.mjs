/**
 * v2：图是平滑放大渲染（块边界有渐变），改为
 * 1) 收紧裁剪 2) 通道量化 3) 候选块边长搜索（重建误差最小者胜）
 * 4) 输出逻辑网格 + 调色板 + ASCII
 */
import sharp from 'sharp'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] ?? String.raw`C:\Users\cgisk\.zcode\cli\image-cache\sess_aedeeb39-1d1d-4e1a-9fc4-c46d7f093a23\image-53b49ceb6e05d81d7e35f66c41c146d7.png`

const LEFT = Number(process.argv[3] ?? 30)
const TOP = Number(process.argv[4] ?? 37)
const WIDTH = Number(process.argv[5] ?? 150)
const HEIGHT = Number(process.argv[6] ?? 213)

const { data, info } = await sharp(SRC).extract({ left: LEFT, top: TOP, width: WIDTH, height: HEIGHT }).raw().toBuffer({ resolveWithObject: true })
const W = info.width
const ch = info.channels
const px = (x, y) => {
  const i = (y * W + x) * ch
  return [data[i], data[i + 1], data[i + 2]]
}
const q = (c) => Math.round(c / 28) * 28 // 量化桶 28

// 候选块边长：网格采样后统计「混色单元」占比 + 色数，综合打分
let best = null
for (const block of [8, 9, 10, 11, 12, 13]) {
  const gw = Math.floor(W / block)
  const gh = Math.floor(HEIGHT / block)
  const cells = []
  let mixed = 0
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const buckets = new Map()
      for (let dy = 0; dy < block; dy += 2) {
        for (let dx = 0; dx < block; dx += 2) {
          const c = px(gx * block + dx, gy * block + dy)
          const k = `${q(c[0])},${q(c[1])},${q(c[2])}`
          buckets.set(k, (buckets.get(k) ?? 0) + 1)
        }
      }
      const total = [...buckets.values()].reduce((a, b) => a + b, 0)
      const dom = Math.max(...buckets.values())
      if (dom / total < 0.72) mixed++
      cells.push(buckets)
    }
  }
  const colors = new Set()
  for (const b of cells) for (const k of b.keys()) colors.add(k)
  const score = mixed / (gw * gh) + colors.size / 400
  console.log(`block=${block} 网格${gw}x${gh} 混色率=${(mixed / (gw * gh)).toFixed(3)} 色数=${colors.size} 分=${score.toFixed(4)}`)
  if (!best || score < best.score) best = { block, gw, gh, score }
}
const { block, gw, gh } = best
console.log(`→ 选定 block=${block}`)

// 用选定块边长重建网格（单元主色）
const grid = []
const cells = []
for (let gy = 0; gy < gh; gy++) {
  const row = []
  for (let gx = 0; gx < gw; gx++) {
    const buckets = new Map()
    for (let dy = 0; dy < block; dy++) {
      for (let dx = 0; dx < block; dx++) {
        const c = px(gx * block + dx, gy * block + dy)
        const k = `${q(c[0])},${q(c[1])},${q(c[2])}`
        buckets.set(k, (buckets.get(k) ?? 0) + 1)
      }
    }
    let domK = null
    let domN = -1
    for (const [k, n] of buckets) {
      if (n > domN) {
        domN = n
        domK = k
      }
    }
    cells.push({ gx, gy, domK, domN, total: block * block })
    row.push(domK)
  }
  grid.push(row)
}

// 背景桶 = 出现最多的桶
const freq = new Map()
for (const c of cells) freq.set(c.domK, (freq.get(c.domK) ?? 0) + c.domN)
const bgK = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0]

// 前景单元再聚类成符号（按量化桶）
const syms = new Map()
const lines = []
for (let gy = 0; gy < gh; gy++) {
  let line = ''
  for (let gx = 0; gx < gw; gx++) {
    const k = grid[gy][gx]
    if (k === bgK) {
      line += '.'
      continue
    }
    if (!syms.has(k)) syms.set(k, String.fromCharCode(65 + syms.size))
    line += syms.get(k)
  }
  lines.push(line)
}
console.log('前景符号:')
const palObj = {}
for (const [k, sym] of syms) {
  const [r, g, b] = k.split(',').map((v) => Math.min(255, Number(v)))
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  console.log(`  ${sym} = ${hex} (${k})`)
  palObj[sym] = hex
}
for (const l of lines) console.log(l)
writeFileSync(join(ROOT, 'assets', 'base-grid.json'), JSON.stringify({ block, left: LEFT, top: TOP, gw, gh, bg: bgK, palette: palObj, grid: lines }, null, 2) + '\n')
console.log('base-grid.json ✓')

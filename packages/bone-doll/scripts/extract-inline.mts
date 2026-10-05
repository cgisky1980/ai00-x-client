import sharp from 'sharp'
const SRC = String.raw`C:\Users\cgisk\.zcode\cli\image-cache\sess_aedeeb39-1d1d-4e1a-9fc4-c46d7f093a23\image-53b49ceb6e05d81d7e35f66c41c146d7.png`
const { data, info } = await sharp(SRC).extract({ left: 20, top: 25, width: 175, height: 235 }).raw().toBuffer({ resolveWithObject: true })
const W = info.width, ch = info.channels, H = info.height
const px = (x: number, y: number) => { const i = (y * W + x) * ch; return [data[i], data[i+1], data[i+2]] }
const corner = px(2, 2)
const isBg = (c: number[]) => Math.abs(c[0]-corner[0]) + Math.abs(c[1]-corner[1]) + Math.abs(c[2]-corner[2]) < 60
let minX = W, minY = H, maxX = 0, maxY = 0
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isBg(px(x, y))) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
console.log('紧包围盒(相对裁剪):', minX, minY, maxX - minX + 1, 'x', maxY - minY + 1, '→ 原图 x', 20 + minX, 'y', 25 + minY)
for (const block of [8, 9, 10, 11, 12]) {
  const gw = Math.floor((maxX - minX + 1) / block), gh = Math.floor((maxY - minY + 1) / block)
  let fg = 0
  const total = gw * gh
  const lines: string[] = []
  for (let gy = 0; gy < gh; gy++) { let line = ''
    for (let gx = 0; gx < gw; gx++) {
      const buckets = new Map<string, number>()
      for (let dy = 0; dy < block; dy += 2) for (let dx = 0; dx < block; dx += 2) {
        const c = px(minX + gx * block + dx, minY + gy * block + dy)
        if (isBg(c)) continue
        const k = Math.round(c[0]/40)+','+Math.round(c[1]/40)+','+Math.round(c[2]/40)
        buckets.set(k, (buckets.get(k) ?? 0) + 1)
      }
      const n = [...buckets.values()].reduce((a, b) => a + b, 0)
      const isFg = n >= (block * block / 4) / 2
      if (isFg) fg++
      line += isFg ? '#' : '.'
    }
    lines.push(line)
  }
  console.log('block=' + block + ' 网格' + gw + 'x' + gh + ' 前景占比=' + (fg / total).toFixed(2))
  for (const l of lines) console.log(' ', l)
}

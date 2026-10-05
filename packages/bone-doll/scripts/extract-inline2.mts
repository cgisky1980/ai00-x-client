import sharp from 'sharp'
const SRC = String.raw`C:\Users\cgisk\.zcode\cli\image-cache\sess_aedeeb39-1d1d-4e1a-9fc4-c46d7f093a23\image-53b49ceb6e05d81d7e35f66c41c146d7.png`
const { data, info } = await sharp(SRC).extract({ left: 20, top: 25, width: 175, height: 235 }).raw().toBuffer({ resolveWithObject: true })
const W = info.width, ch = info.channels
const px = (x: number, y: number) => { const i = (y * W + x) * ch; return [data[i], data[i+1], data[i+2]] }
const corner = px(2, 2)
const isBg = (c: number[]) => Math.abs(c[0]-corner[0]) + Math.abs(c[1]-corner[1]) + Math.abs(c[2]-corner[2]) < 60
const minX = 12, minY = 14, block = 9
const gw = Math.floor((W - minX) / block) - 1 // 14
const gh = 23
const symOf = (c: number[]): string => {
  if (isBg(c)) return '.'
  const [r, g, b] = c
  if (r < 110 && g < 110 && b < 110) return 'E' // 深色（眼/嘴）
  if (r > 220 && g > 190 && b > 170) return 's' // 亮肤
  if (r > 200 && g > 160 && b > 140) return 'S' // 暗肤
  if (r > 170 && g > 130) return 's'
  return '?'
}
const avg: Record<string, string> = {}
for (let gy = 0; gy < gh; gy++) {
  let line = ''
  for (let gx = 0; gx < gw; gx++) {
    // 单元主类：取多数像素类并求平均色
    const acc: Record<string, { n: number, r: number, g: number, b: number }> = {}
    for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block; dx++) {
      const c = px(minX + gx * block + dx, minY + gy * block + dy)
      const s = symOf(c)
      acc[s] ??= { n: 0, r: 0, g: 0, b: 0 }
      acc[s].n++; acc[s].r += c[0]; acc[s].g += c[1]; acc[s].b += c[2]
    }
    let best = '.', bestN = 0
    for (const [s, v] of Object.entries(acc)) if (s !== '.' && v.n > bestN) { best = s; bestN = v.n }
    line += best
    if (best !== '.') {
      const v = acc[best]
      avg[best] = '#' + [v.r / v.n, v.g / v.n, v.b / v.n].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
    }
  }
  console.log(String(gy).padStart(2) + ' ' + line)
}
console.log('均色:', JSON.stringify(avg))

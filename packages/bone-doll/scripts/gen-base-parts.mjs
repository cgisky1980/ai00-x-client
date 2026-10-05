/**
 * chibi 素体生成器 v3 —— 以用户手绘 1 号素体为标准（画风宪法终稿输入）。
 *
 * 提取自 24 宫格设定图（scripts/extract-base.mjs / extract-inline.mts）：
 * - 网格 14×23（块=2px 映射到 64×64 画布，原点 (18,12)，脚底 y58）
 * - 头 ≈ 24px 方圆块 + 两侧耳朵（≈身高 2/3），无描边扁平风
 * - 极简竖线眼（#28150d）+ 1px 嘴；肤色主 #f6caa8
 * - 4 方向 = down/up/side 三视图（left 运行时镜像）
 * - 部件 = 素体 8 件（裸体肤色）+ 绒球帽/木剑/红披风 3 件装饰（stack 槽）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PixBuf } from './lib/pixbuf.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets', 'parts')
mkdirSync(OUT, { recursive: true })

// ------------------------------------------------------------ 调色板锁（v3，肤色取自用户素体）
export const PALETTE = {
  skin: '#f6caa8',
  skinShade: '#e3ab8a',
  eye: '#28150d',
  hair: '#4a5568',
  hairShade: '#39445a',
  hairHi: '#5d6b82',
  top: '#4f7396',
  topShade: '#3c5a78',
  bottom: '#565668',
  bottomShade: '#434353',
  shoe: '#8a5a44',
  shoeShade: '#6d4636',
  wood: '#b98d5f',
  woodHi: '#d3ab7c',
  woodShade: '#956c44',
  hat: '#c25e5e',
  hatShade: '#9e4646',
  pompom: '#f0e6d2',
}
const C = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, new PixBuf().hex(v)]))

const draw = (name, fn) => {
  const buf = new PixBuf(64, 64)
  fn(buf)
  const file = join(OUT, `${name}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buf.toPNG())
  console.log(`gen ${name}.png`)
}

// ------------------------------------------------------------ 正面网格（14×23 → 画布，块=2，原点(18,12)）
const OX = 18
const OY = 12
const B = 2
// 每行前景列区间（含端点）；null = 空行；耳朵行两条区间
const FRONT_ROWS = [
  [3, 10], // 0 头顶（圆角）
  [2, 11], // 1
  [2, 11], // 2
  [0, 13], // 3 耳朵层
  [0, 13], // 4 耳朵层
  [2, 11], // 5 眼
  [2, 11], // 6 眼
  [2, 11], // 7
  [2, 11], // 8 嘴
  [2, 11], // 9
  [2, 11], // 10
  [3, 10], // 11 下颌（圆角）
  [2, 11], // 12 肩（臂+躯干）
  [2, 11], // 13
  [2, 11], // 14
  [2, 11], // 15
  [2, 11], // 16
  [2, 11], // 17
  [2, 11], // 18 躯干下摆+臂底
  [4, 9], // 19 腿
  [4, 9], // 20
  [3, 10], // 21 脚外扩
  [3, 10], // 22 脚
]
const X = (gx) => OX + gx * B
const Y = (gy) => OY + gy * B
const fillRow = (b, gy, g0, g1, c) => b.rect(X(g0), Y(gy), (g1 - g0 + 1) * B, B, c)

// 头（正面）：行 0..11
const headFront = (b) => {
  for (let gy = 0; gy <= 11; gy++) {
    const [g0, g1] = FRONT_ROWS[gy]
    fillRow(b, gy, g0, g1, C.skin)
  }
}
// 躯干（正面）：行 12..18 的中段（臂占 2..3 与 10..11）
const torsoFront = (b) => {
  for (let gy = 12; gy <= 18; gy++) fillRow(b, gy, 4, 9, C.skin)
}
const armLFront = (b) => {
  for (let gy = 12; gy <= 18; gy++) fillRow(b, gy, 2, 3, C.skin)
}
const armRFront = (b) => {
  for (let gy = 12; gy <= 18; gy++) fillRow(b, gy, 10, 11, C.skin)
}
// 腿（正面）：裤段行 19..20，脚段行 21..22 外扩
const legLFront = (b) => {
  fillRow(b, 19, 4, 6, C.skin)
  fillRow(b, 20, 4, 6, C.skin)
  fillRow(b, 21, 3, 5, C.skin)
  fillRow(b, 22, 3, 5, C.skin)
}
const legRFront = (b) => {
  fillRow(b, 19, 7, 9, C.skin)
  fillRow(b, 20, 7, 9, C.skin)
  fillRow(b, 21, 7, 10, C.skin)
  fillRow(b, 22, 7, 10, C.skin)
}

draw('head/down', headFront)
draw('head/up', headFront)
draw('head/right', (b) => {
  // 侧头 = 方圆块右移 1px + 鼻尖
  b.rect(23, 14, 22, 20, C.skin)
  b.rect(25, 12, 18, 2, C.skin)
  b.rect(25, 34, 18, 2, C.skin)
  b.rect(44, 23, 2, 2, C.skin) // 鼻
})
draw('face/down', (b) => {
  b.rect(X(4), Y(5), 4, 4, C.eye) // 左眼 2×2 块
  b.rect(X(9), Y(5), 4, 4, C.eye) // 右眼
  b.rect(X(6), Y(8), 4, 2, C.eye) // 嘴
})
draw('face/right', (b) => {
  b.rect(40, 22, 2, 4, C.eye) // 竖线眼贴前缘
  b.rect(42, 31, 2, 1, C.skinShade)
})

// ------------------------------------------------------------ 躯干 / 四肢（裸体肤色版）

draw('torso/down', (b) => torsoFront(b))
draw('torso/up', (b) => torsoFront(b))
draw('torso/right', (b) => {
  b.rect(28, 36, 10, 14, C.skin) // 侧躯干
  b.rect(38, 39, 1, 3, C.skin) // 挺胸
})

const armF = (x) => (b) => {
  b.rect(x, 36, 4, 14, C.skin)
}
draw('armL/down', armF(X(2)))
draw('armL/up', armF(X(2)))
draw('armL/right', armF(36)) // 远侧臂（前缘，躯干后露窄条）
draw('armR/down', armF(X(10)))
draw('armR/up', armF(X(10)))
draw('armR/right', armF(28)) // 近侧臂（后侧，躯干上层）

const legF = (px, sx) => (b) => {
  b.rect(px, 51, 4, 4, C.skin) // 腿
  b.rect(sx, 55, 6, 3, C.skin) // 脚
}
draw('legL/down', legF(X(4), X(3)))
draw('legL/up', legF(X(4), X(3)))
draw('legL/right', legF(32, 31)) // 远侧腿（前迈半步）
draw('legR/down', legF(X(7), X(7)))
draw('legR/up', legF(X(7), X(7)))
draw('legR/right', legF(28, 27)) // 近侧腿（收后）

// ------------------------------------------------------------ 装饰件（stack 槽 demo）

// 绒球帽：大块盖顶（头 y12~35 → 帽 y12~22）+ 绒球
const hatAt = (x, w) => (b) => {
  b.rect(x, 13, w, 9, C.hat)
  b.rect(x + 2, 12, w - 4, 1, C.hat) // 顶缘内收
  b.rect(x, 22, w, 1, C.hatShade) // 帽檐阴影
  b.ellipse(x + Math.floor(w / 2), 9, 3, 3, C.pompom)
}
draw('hat/kerchief/down', hatAt(18, 28))
draw('hat/kerchief/up', hatAt(18, 28))
draw('hat/kerchief/right', hatAt(19, 27))

// 木剑：直立握在近手（近手 y42~46）
draw('weapon/sword-wood/down', (b) => {
  b.rect(40, 34, 2, 10, C.wood)
  b.rect(40, 34, 1, 10, C.woodHi)
  b.rect(39, 44, 4, 1, C.woodShade)
  b.rect(40, 45, 2, 2, C.woodShade)
})
draw('weapon/sword-wood/up', (b) => {
  b.rect(40, 34, 2, 10, C.wood)
  b.rect(41, 34, 1, 10, C.woodHi)
  b.rect(39, 44, 4, 1, C.woodShade)
  b.rect(40, 45, 2, 2, C.woodShade)
})
draw('weapon/sword-wood/right', (b) => {
  b.rect(29, 34, 2, 10, C.wood)
  b.rect(29, 34, 1, 10, C.woodHi)
  b.rect(28, 44, 4, 1, C.woodShade)
  b.rect(29, 45, 2, 2, C.woodShade)
})

// 披风：正面/背面 = 身后整幅；侧视 = 贴身披挂盖后半身（z 在手臂后面）+ 下摆外扩飘角
const capeAt = (x, w) => (b) => {
  b.rect(x, 36, w, 13, C.hatShade)
  b.rect(x + Math.floor(w / 2) - 1, 48, 2, 3, C.hatShade) // 燕尾中尖
  b.rect(x, 47, w, 2, C.hat) // 下摆缘
}
draw('cape/red/down', capeAt(25, 14))
draw('cape/red/up', capeAt(25, 14))
draw('cape/red/right', (b) => {
  b.rect(27, 36, 7, 12, C.hatShade) // 贴身主体：躯干后半 28..32，向后探 1px
  b.rect(26, 48, 8, 1, C.hat) // 下摆微扩
  b.rect(25, 49, 3, 2, C.hatShade) // 向后下飘角
})

writeFileSync(
  join(ROOT, 'assets', 'palette.json'),
  JSON.stringify({ version: 2, note: 'chibi 素体 v3 调色板锁（肤色取自用户手绘素体；19 色，随手工终审迭代）', colors: PALETTE }, null, 2) + '\n',
)
console.log('palette.json ✓')

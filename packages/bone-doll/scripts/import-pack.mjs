/**
 * 素体工坊导出的部件包落盘脚本：
 *   node scripts/import-pack.mjs <bone-doll-pack-xxx.json>
 *
 * 动作：1) 部件 PNG 写入 assets/parts 与 doll2  2) skeletonPatch.parts 合并进 skeleton.json
 *      3) 基础槽部件（head/torso/arms/legs/face）自动追加 defaultEquip（装饰槽手动穿）
 *      4) Spine 部件库：PNG 另存 assets/spine/parts/ + 变体清单合并进 assets/spine/parts/config.json
 *        （入库后重跑 gen-spine-skeleton.mjs 全量聚合 atlas/skins）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOLL2 = resolve(ROOT, '../../src/underlay-ui/public/pet/doll2')
const BASE_SLOTS = new Set(['head', 'face', 'torso', 'armL', 'armR', 'legL', 'legR'])

const bundlePath = process.argv[2]
if (!bundlePath) {
  console.error('用法: node scripts/import-pack.mjs <bone-doll-pack-xxx.json>')
  process.exit(1)
}
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
if (bundle.kind !== 'bone-doll-part-pack') throw new Error('不是 bone-doll-part-pack 格式')

for (const [path, dataUrl] of Object.entries(bundle.files)) {
  const b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1)
  const buf = Buffer.from(b64, 'base64')
  for (const base of [join(ROOT, 'assets'), DOLL2]) {
    const f = join(base, path)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, buf)
  }
}

const skelPath = join(ROOT, 'assets', 'skeleton.json')
const skel = JSON.parse(readFileSync(skelPath, 'utf8'))
const patch = bundle.skeletonPatch?.parts ?? {}
let merged = 0
for (const [key, def] of Object.entries(patch)) {
  skel.parts[key] = def
  merged++
}
for (const key of bundle.defaultEquipAdd ?? []) {
  const def = skel.parts[key]
  if (def && BASE_SLOTS.has(def.slot) && !skel.defaultEquip.includes(key)) skel.defaultEquip.push(key)
}
writeFileSync(skelPath, JSON.stringify(skel, null, 2) + '\n')
// ---- Spine 部件库落盘：PNG → assets/spine/parts/，变体清单合并 → parts/config.json
const SPINE = join(ROOT, 'assets', 'spine')
for (const [path, dataUrl] of Object.entries(bundle.files)) {
  const b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1)
  const f = join(SPINE, path)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, Buffer.from(b64, 'base64'))
}
const configPath = join(SPINE, 'parts', 'config.json')
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { version: 1, slots: {} }
config.version = config.version ?? 1
config.slots = config.slots ?? {}
let libVariants = 0
for (const [key, def] of Object.entries(patch)) {
  const slotKey = def.slot
  const variantName = key.includes('/') ? key.split('/').pop() : key
  if (!slotKey || !variantName) throw new Error(`import-pack: 部件键无法解析 ${key}`)
  if (!config.slots[slotKey]) config.slots[slotKey] = { variants: {} }
  config.slots[slotKey].variants = config.slots[slotKey].variants ?? {}
  // images.src 为相对 assets/spine/ 的路径（与 bundle.files 一致）；dyeable 为可染色标记预留
  config.slots[slotKey].variants[variantName] = {
    label: def.name ?? variantName,
    images: Object.fromEntries(Object.entries(def.images ?? {}).map(([d, img]) => [d, { src: img.src }])),
    dyeable: false,
  }
  libVariants++
}
mkdirSync(dirname(configPath), { recursive: true })
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

writeFileSync(join(DOLL2, 'skeleton.json'), JSON.stringify(skel, null, 2) + '\n')
console.log(`✓ 落盘 ${Object.keys(bundle.files).length} 张部件图（assets + doll2 + spine）；parts 合并 ${merged}；defaultEquip 现有 ${skel.defaultEquip.length} 件；spine 变体 ${libVariants}（config.json）—— 重跑 node scripts/gen-spine-skeleton.mjs 聚合`)

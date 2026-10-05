import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compose,
  compileAnim,
  computeWorld,
  deviceBase,
  IDENT,
  resolveSampleTime,
  resolveSetup,
  sampleAnim,
  sampleField,
  slotDrawZ,
  trs,
  validateSkeleton,
} from './math'
import type { SkeletonAsset } from './types'

const approx = (actual: number, expected: number, msg = ''): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `approx: actual=${actual} expected=${expected} ${msg}`,
  )
}

test('trs: 单位旋转 = 纯平移', () => {
  const m = trs(10, 20, 0)
  approx(m.a, 1)
  approx(m.b, 0)
  approx(m.c, 0)
  approx(m.d, 1)
  approx(m.e, 10)
  approx(m.f, 20)
})

test('trs: 90° 旋转把 (1,0) 映到 (0,1)（canvas y 向下，顺时针）', () => {
  const m = trs(0, 0, 90)
  approx(m.a, 0)
  approx(m.b, 1)
  approx(m.c, -1)
  approx(m.d, 0)
})

test('compose: 单位元恒等 + 结合律样例', () => {
  const p = trs(32, 44, 10)
  const l = trs(0, -7, -10)
  const pl = compose(p, l)
  const middle = compose(p, trs(0, -7, 0))
  const both = compose(middle, trs(0, 0, -10))
  approx(pl.a, both.a)
  approx(pl.f, both.f)
  const id = compose(IDENT, p)
  approx(id.e, p.e)
})

test('deviceBase: left 镜像下画布中心 x 不动', () => {
  const base = deviceBase(64, 4, true)
  const atCenter = compose(base, { a: 1, b: 0, c: 0, d: 1, e: 32, f: 0 })
  approx(atCenter.e, 64 * 4 - 32 * 4) // 256 - 128 = 128 → 设备中心
  const atLeft = compose(base, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  approx(atLeft.e, 256)
})

test('resolveSampleTime: loop 取模折叠 / one-shot 截断', () => {
  approx(resolveSampleTime(2.3, 2, true), 0.3)
  approx(resolveSampleTime(-0.5, 2, true), 1.5)
  approx(resolveSampleTime(3, 2, false), 2)
  approx(resolveSampleTime(-1, 2, false), 0)
})

test('sampleField: 线性插值与端点保持', () => {
  const track = [
    { t: 0, r: 10 },
    { t: 1, r: 30 },
  ]
  approx(sampleField(track, 0.25, 1, false, 0, 'r'), 15)
  approx(sampleField(track, 0, 1, false, 0, 'r'), 10)
  approx(sampleField(track, 2, 1, false, 0, 'r'), 30) // 终点后保持末值
  approx(sampleField(track, 5, 1, false, 99, 'x'), 99) // 该字段无定义 → setup
})

test('sampleField: loop 首尾跨接（末帧之后回绕首帧）', () => {
  const track = [
    { t: 0, r: 0 },
    { t: 0.8, r: 40 },
  ]
  // duration=1：t=0.9 位于 0.8 与（回绕的）0 之间中点 → 20
  approx(sampleField(track, 0.9, 1, true, 0, 'r'), 20)
  // t=0.95：回绕段 0.2 走了 0.15（w=0.75）→ 40→0 的 25% = 10
  approx(sampleField(track, 0.95, 1, true, 0, 'r'), 10)
})

test('sampleAnim: setup ∪ 轨道覆盖', () => {
  const setup = new Map([
    ['body', { x: 0, y: -6, r: 0 }],
    ['head', { x: 0, y: -6, r: 0 }],
  ])
  const compiled = compileAnim([{ t: 0, bones: { body: { y: -7 } } }])
  const poses = sampleAnim(compiled, 0, 1, false, setup)
  approx(poses.get('body')!.y, -7)
  approx(poses.get('body')!.x, 0) // 未动字段 = setup
  approx(poses.get('head')!.y, -6) // 未提及骨骼 = setup
})

test('computeWorld: 两骨链旋转 + 取整', () => {
  const bones = [
    { key: 'root', parent: null, x: 32, y: 44 },
    { key: 'head', parent: 'root', x: 0, y: -7 },
  ]
  const local = new Map([
    ['root', { x: 32, y: 44, r: 0 }],
    ['head', { x: 0, y: -7, r: 90 }],
  ])
  const world = computeWorld(bones, local, true)
  const head = world.get('head')!
  approx(head.e, 32)
  approx(head.f, 37)
  // 世界矩阵把 (1,0) 旋到 (0,1)：设备点 = (32, 38)
  approx(head.a, 0, 'cos90')
  approx(head.b, 1, 'sin90')
})

test('computeWorld: 平移取整（子骨继承整数枢轴）', () => {
  const bones = [
    { key: 'root', parent: null, x: 32.4, y: 44 },
    { key: 'body', parent: 'root', x: 0, y: -6 },
  ]
  const local = new Map([
    ['root', { x: 32.4, y: 44, r: 0 }],
    ['body', { x: 0, y: -6, r: 0 }],
  ])
  const world = computeWorld(bones, local, true)
  approx(world.get('root')!.e, 32)
  approx(world.get('body')!.e, 32)
  approx(world.get('body')!.f, 38)
})

test('computeWorld: 乱序数组 + 成环检测', () => {
  const bones = [
    { key: 'body', parent: 'root', x: 0, y: -6 },
    { key: 'root', parent: null, x: 32, y: 44 },
  ]
  const local = new Map([
    ['root', { x: 32, y: 44, r: 0 }],
    ['body', { x: 0, y: -6, r: 0 }],
  ])
  const world = computeWorld(bones, local, false)
  approx(world.get('body')!.f, 38)
  assert.throws(() =>
    computeWorld([{ key: 'a', parent: 'b', x: 0, y: 0 }, { key: 'b', parent: 'a', x: 0, y: 0 }], new Map(), false),
  )
})

test('resolveSetup: 方向校准 + left 继承 right', () => {
  const bones = [
    { key: 'root', parent: null, x: 32, y: 49 },
    { key: 'armR', parent: 'root', x: 8, y: -4 },
  ]
  const setups = { right: { armR: { x: 2 } } }
  approx(resolveSetup(bones, setups, 'down').get('armR')!.x, 8)
  approx(resolveSetup(bones, setups, 'right').get('armR')!.x, 2)
  approx(resolveSetup(bones, setups, 'left').get('armR')!.x, 2)
  approx(resolveSetup(bones, setups, 'up').get('armR')!.x, 8)
  approx(resolveSetup(bones, setups, 'right').get('armR')!.y, -4) // 漏字段用基础值
})

test('slotDrawZ: 背/侧视角专用 z（披风 up 盖背、side 披身）', () => {
  const cape = { key: 'cape', bone: 'body', z: 5, zBackView: 33, zSideView: 31 }
  const torso = { key: 'torso', bone: 'body', z: 30 }
  approx(slotDrawZ(cape, 'down'), 5) // 正面：披风在身后
  approx(slotDrawZ(cape, 'right'), 31) // 侧面：披在身上盖过躯干（30）
  approx(slotDrawZ(cape, 'left'), 31)
  approx(slotDrawZ(cape, 'up'), 33) // 背面：盖住躯干（30）
  approx(slotDrawZ(torso, 'up'), 30) // 无专用 z 的槽位不随方向变
  approx(slotDrawZ(torso, 'right'), 30)
})

test('validateSkeleton: 合法资产零错误', () => {
  const asset: SkeletonAsset = {
    version: 1,
    frame: 64,
    directions: ['down', 'up', 'right'],
    bones: [
      { key: 'root', parent: null, x: 32, y: 49 },
      { key: 'body', parent: 'root', x: 0, y: -6 },
    ],
    slots: [{ key: 'torso', bone: 'body', z: 20 }],
    parts: {
      'torso/base': {
        slot: 'torso',
        images: { down: { src: 'parts/torso/down.png' } },
      },
    },
    animations: {
      idle: { duration: 1, loop: true, tracks: { down: [{ t: 0, bones: { body: { y: -7 } } }] } },
      hit: { duration: 0.5, loop: false, next: 'idle', tracks: {} },
    },
  }
  assert.deepEqual(validateSkeleton(asset), [])
})

test('validateSkeleton: 抓出断链/环/越界', () => {
  const asset = {
    version: 1,
    frame: 64,
    directions: ['down', 'up', 'right'],
    bones: [
      { key: 'root', parent: null, x: 32, y: 49 },
      { key: 'a', parent: 'ghost', x: 0, y: 0 },
      { key: 'b', parent: 'c', x: 0, y: 0 },
      { key: 'c', parent: 'b', x: 0, y: 0 },
    ],
    slots: [{ key: 's', bone: 'nobody', z: 1 }],
    parts: { p: { slot: 'missing', images: { front: { src: 'x.png' } } } },
    animations: {
      bad: {
        duration: 1,
        loop: true,
        next: 'nope',
        tracks: { down: [{ t: 2, bones: { nobody: { y: 0 } } }] },
      },
    },
  } as unknown as SkeletonAsset
  const errs = validateSkeleton(asset)
  assert.ok(errs.some((e) => e.includes('ghost')), '断链父骨')
  assert.ok(errs.some((e) => e.includes('成环')), '骨骼环')
  assert.ok(errs.some((e) => e.includes('nobody')), '槽位断链')
  assert.ok(errs.some((e) => e.includes('missing')), '部件槽位断链')
  assert.ok(errs.some((e) => e.includes('front')), '非法方向')
  assert.ok(errs.some((e) => e.includes('nope')), 'next 不存在')
  assert.ok(errs.some((e) => e.includes('越界')), '关键帧越界')
})

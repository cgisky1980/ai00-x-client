import { PaperDoll } from '../src/index'

const canvas = document.getElementById('stage') as HTMLCanvasElement
const status = document.getElementById('status') as HTMLElement
const equippedEl = document.getElementById('equipped') as HTMLElement
const treeEl = document.getElementById('tree') as HTMLElement
const searchEl = document.getElementById('search') as HTMLInputElement

function group(
  id: string,
  opts: string[],
  initial: string,
  onPick: (v: string) => void,
): void {
  const root = document.getElementById(id) as HTMLElement
  for (const o of opts) {
    const b = document.createElement('button')
    b.textContent = o
    b.classList.toggle('on', o === initial)
    b.onclick = () => {
      for (const el of root.querySelectorAll('button')) el.classList.remove('on')
      b.classList.add('on')
      onPick(o)
    }
    root.appendChild(b)
  }
}

let doll: PaperDoll

/** 点击部件按钮：已穿 → 脱；未穿 → 穿（同 typeName 自动互斥）。 */
async function togglePart(key: string, btn: HTMLButtonElement): Promise<void> {
  if (doll.isEquipped(key)) {
    doll.unequip(key)
  } else {
    btn.disabled = true
    try {
      await doll.equip(key)
    } finally {
      btn.disabled = false
    }
  }
  refresh()
}

function refresh(): void {
  for (const btn of treeEl.querySelectorAll<HTMLButtonElement>('button[data-key]')) {
    btn.classList.toggle('on', doll.isEquipped(btn.dataset.key!))
  }
  equippedEl.textContent =
    `已装备 ${doll.equipped().length} 件：` +
    doll.equipped().map((k) => doll.manifest.parts[k].name).join('、')
}

function buildTree(): void {
  // 分类 → 分组两段式树（manifest.groups 已按 group 排序）
  const byCat = new Map<string, typeof groups>()
  const groups = doll.listGroups()
  for (const g of groups) {
    const arr = byCat.get(g.category) ?? []
    arr.push(g)
    byCat.set(g.category, arr)
  }
  for (const [cat, gs] of byCat) {
    const catEl = document.createElement('details')
    catEl.className = 'cat'
    const catSum = document.createElement('summary')
    catSum.textContent = cat
    catEl.appendChild(catSum)
    for (const g of gs) {
      const grpEl = document.createElement('details')
      grpEl.className = 'grp'
      grpEl.dataset.group = g.group
      const grpSum = document.createElement('summary')
      const seg = g.group.split('/')
      grpSum.innerHTML = `${seg[seg.length - 1]} <span class="count">${g.keys.length}</span>`
      grpSum.title = g.group
      grpEl.appendChild(grpSum)
      const partsEl = document.createElement('div')
      partsEl.className = 'parts'
      for (const key of g.keys) {
        const p = doll.manifest.parts[key]
        const b = document.createElement('button')
        b.textContent = p.name
        b.dataset.key = key
        b.title = `${key}\n变体 ${p.variants.length} 种${p.variants.length ? `（当前 ${p.variantExported ?? '默认'}）` : ''}`
        b.onclick = () => void togglePart(key, b)
        partsEl.appendChild(b)
      }
      grpEl.appendChild(partsEl)
      catEl.appendChild(grpEl)
    }
    treeEl.appendChild(catEl)
  }
}

/** 搜索过滤：匹配名称/路径；输入非空时全展开并隐藏无匹配组。 */
function applyFilter(): void {
  const q = searchEl.value.trim().toLowerCase()
  for (const catEl of treeEl.querySelectorAll<HTMLDetailsElement>('details.cat')) {
    let catVisible = false
    for (const grpEl of catEl.querySelectorAll<HTMLDetailsElement>('details.grp')) {
      let grpVisible = false
      for (const btn of grpEl.querySelectorAll<HTMLButtonElement>('button[data-key]')) {
        const key = btn.dataset.key!
        const hit = q === '' || key.toLowerCase().includes(q) || btn.textContent!.toLowerCase().includes(q)
        btn.classList.toggle('hide', !hit)
        if (hit) grpVisible = true
      }
      grpEl.classList.toggle('hide', !grpVisible)
      grpEl.open = q !== '' && grpVisible
      if (grpVisible) catVisible = true
    }
    catEl.classList.toggle('hide', !catVisible)
    catEl.open = q !== '' || catEl.open
  }
}

async function main(): Promise<void> {
  doll = await PaperDoll.load('/pet/doll/', { scale: 3 })
  doll.attach(canvas)
  doll.play('idle')

  status.textContent =
    `部件 ${Object.keys(doll.manifest.parts).length} / 分组 ${doll.listGroups().length}` +
    ` / 动画 ${doll.listAnims().join('+')}`
  group('anims', doll.listAnims(), 'idle', (v) => doll.play(v))
  group('dirs', doll.manifest.directions, doll.currentDirection, (v) => doll.setDirection(v))
  group('scales', ['2', '3', '4', '6'], '3', (v) => doll.setScale(Number(v)))

  buildTree()
  refresh()
  searchEl.addEventListener('input', applyFilter)
  ;(window as unknown as Record<string, unknown>).__doll = doll // 调试句柄

}

main().catch((e) => {
  status.textContent = `载入失败：${e instanceof Error ? e.message : String(e)}`
  console.error(e)
})

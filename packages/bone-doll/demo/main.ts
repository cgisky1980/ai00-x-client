import { BoneDoll } from '../src/index'

const canvas = document.getElementById('stage') as HTMLCanvasElement
const status = document.getElementById('status') as HTMLElement

function buttonGroup(
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

async function boot(): Promise<void> {
  try {
    const doll = await BoneDoll.load('/', { scale: 4 })
    doll.attach(canvas)
    doll.play('idle')
    status.textContent = `已装备: ${doll.equipped().join(', ')}`

    buttonGroup('anims', doll.listAnims(), 'idle', (v) => doll.play(v, { restart: true }))
    buttonGroup('dirs', ['down', 'up', 'left', 'right'], 'down', (v) => doll.setDirection(v as never))

    // 换装开关：素体必备件已穿；装饰件（hat/weapon）可穿脱
    const partsRoot = document.getElementById('parts') as HTMLElement
    for (const [key, def] of Object.entries(doll.skeleton.parts)) {
      const b = document.createElement('button')
      b.textContent = def.name ?? key
      const isBase = (doll.skeleton.defaultEquip ?? []).includes(key)
      b.classList.toggle('on', isBase)
      b.onclick = async () => {
        if (doll.isEquipped(key)) {
          doll.unequip(key)
          b.classList.remove('on')
        } else {
          await doll.equip(key)
          b.classList.add('on')
        }
        status.textContent = `已装备: ${doll.equipped().join(', ')}`
      }
      partsRoot.appendChild(b)
    }

    const scaleEl = document.getElementById('scale') as HTMLInputElement
    const scaleVal = document.getElementById('scaleVal') as HTMLElement
    scaleEl.oninput = () => {
      const s = Number(scaleEl.value)
      doll.setScale(s)
      scaleVal.textContent = `${s}×`
    }
  } catch (e) {
    status.textContent = `boot 失败: ${e instanceof Error ? e.stack : String(e)}`
  }
}

void boot()

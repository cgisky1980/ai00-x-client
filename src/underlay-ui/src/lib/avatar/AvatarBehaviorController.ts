import Matter from 'matter-js'
import * as PIXI from 'pixi.js'
import type { Spine } from '@esotericsoftware/spine-pixi-v8'
import type { PhysicsSystem } from '../physics/PhysicsSystem'
import type { GardenManager } from '../world/GardenManager'
import type { AvatarActivity, AvatarMood } from '../world/types'
import { SpeechBubbleSystem } from './SpeechBubbleSystem'
import { NameTag, NAME_TAG_Y } from './NameTag'

/** 化身缩放比例（与 UserAvatar.AVATAR_SCALE 保持一致，本地定义以避免循环依赖） */
const AVATAR_SCALE = 0.6

/**
 * 化身行为状态（旧 5 状态，仅 Spine 动画层面使用）
 */
export type AvatarState = 'Idle' | 'Walk' | 'Jump' | 'Fly' | 'Roll'

/**
 * 行为决策类型
 */
type BehaviorAction =
  | { type: 'explore'; targetX: number }
  | { type: 'idle'; duration: number }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'rest' }
  | { type: 'read' }
  | { type: 'water' }
  | { type: 'continue' }

/**
 * 化身行为控制器（v2）
 *
 * v1：纯客户端 5 状态随机（Idle/Walk/Jump/Fly/Roll）
 * v2：增加 15 种"活动(Activity)"映射到 GardenManager，并在头顶显示气泡
 *     - 基础移动仍走 Spine 5 动画
 *     - 本地活动（reading/watering/resting 等）通过气泡 + Spine idle 表达
 *     - 社交活动（playing/chatting/greeting）由 VisitorManager 触发，外部调用 setActivity()
 *
 * 行为循环：每 3-6 秒做一次决策
 * 决策概率（无访客时）：explore 40% / idle 25% / rest 12% / read 10% / water 8% / jump 3% / roll 2%
 * 有访客时：减少外出探索，增加 greeting/playing
 */
export class AvatarBehaviorController {
  private spine: Spine
  private physicsSystem: PhysicsSystem
  private body: Matter.Body
  private gardenManager: GardenManager | null
  private bubble: SpeechBubbleSystem

  private currentState: AvatarState = 'Idle'
  private currentActivity: AvatarActivity = 'idle'
  private currentMood: AvatarMood = 'neutral'
  private isRunning = false
  /** 头顶昵称（金黄发光，区别于访客的白色发光） */
  private nameTag: NameTag | null = null
  private behaviorTimer: ReturnType<typeof setTimeout> | null = null

  /** 行走目标 X（屏幕坐标），null 表示未在行走 */
  private walkTargetX: number | null = null
  /** 行走速度系数（每次行走随机，让速度有变化） */
  private walkSpeedFactor = 0.5 + Math.random() * 0.5
  /** 当前朝向：1=右，-1=左 */
  private facing: 1 | -1 = 1

  /** Spine 动画名缓存 */
  private availableAnimations: string[] = []

  /** 物理参数 */
  private readonly maxSpeedX = 12
  private readonly walkBaseSpeed = 9.6

  /** 当前活动持续到的时间戳（ms），0 表示由外部管理 */
  private activityEndsAt = 0

  /** 外部行走中标志（walkToTarget 期间为 true，阻止随机决策打断） */
  private isExternalWalkPending = false
  /** 外部行走到达目标后的回调 */
  private onArrivedCallback: (() => void) | null = null

  constructor(
    spine: Spine,
    physicsSystem: PhysicsSystem,
    body: Matter.Body,
    gardenManager?: GardenManager,
    bubbleParent?: any,
  ) {
    this.spine = spine
    this.physicsSystem = physicsSystem
    this.body = body
    this.gardenManager = gardenManager ?? null
    // 气泡挂在 spine 的父容器上（避免被 spine scale/flip 影响）
    const parent = bubbleParent ?? (spine.parent as PIXI.Container)
    this.bubble = new SpeechBubbleSystem(parent)

    // 头顶昵称（金黄发光，区别于访客的白色发光；无国旗）
    this.nameTag = new NameTag({
      text: '我',
      fillColor: 0x333333,
      strokeColor: 0xffd700,
      fontSize: 14,
      showFlag: false,
    })
    this.nameTag.view.zIndex = 99
    parent.addChild(this.nameTag.view)

    // 缓存可用动画
    try {
      this.availableAnimations = this.spine.skeleton.data.animations.map(a => a.name)
    } catch {
      this.availableAnimations = []
    }
  }

  /** 启动行为循环 */
  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    // 从 GardenManager 恢复活动状态（如有）
    if (this.gardenManager) {
      const snap = this.gardenManager.getSnapshot()
      // 恢复朝向（直接设 spine scale，不能用 setFacing —— 因为 facing 刚赋值，
      // setFacing 内部 if (this.facing === dir) return 会跳过 scale 设置）
      this.facing = snap.avatar.facing
      this.spine.scale.x = AVATAR_SCALE * this.facing

      // 恢复位置：仅当保存的位置在当前屏幕范围内且在地面以上才恢复，否则保留 body 初始位置
      // （避免上次会话屏幕尺寸不同 / visiting 状态 / 保存时在地面以下等导致位置异常）
      const screenW = window.innerWidth
      const groundTopY = this.physicsSystem.getGroundTopScreenY()
      // body 中心需在地面之上至少 30px（body radius=24，留 6px 余量，避免穿透）
      const safeMaxY = groundTopY - 30
      if (
        snap.avatar.x > 0 && snap.avatar.x < screenW &&
        snap.avatar.y > 0 && snap.avatar.y < safeMaxY &&
        snap.avatar.activity !== 'visiting' &&  // 外出中不恢复位置
        snap.avatar.activity !== 'returning'
      ) {
        const p = this.physicsSystem.screenToPhysics(snap.avatar.x, snap.avatar.y)
        Matter.Body.setPosition(this.body, p)
      }

      // visiting/returning/greeting/playing/chatting 状态刷新后转为 idle
      // （社交活动依赖访客存在，刷新后访客已不在，无法继续；visiting/returning 表示"已回家"）
      const staleActivities = ['visiting', 'returning', 'greeting', 'playing', 'chatting']
      if (staleActivities.includes(snap.avatar.activity)) {
        this.currentActivity = 'idle'
        this.currentMood = 'neutral'
        void this.gardenManager.setAvatarActivity('idle', 'neutral')
      } else {
        this.currentActivity = snap.avatar.activity
        this.currentMood = snap.avatar.mood
      }
    }

    this.playAnimation('Idle', true)
    this.bubble.showForActivity(this.currentActivity)
    this.scheduleNextDecision()
  }

  /** 停止行为循环 */
  stop(): void {
    this.isRunning = false
    if (this.behaviorTimer) {
      clearTimeout(this.behaviorTimer)
      this.behaviorTimer = null
    }
    this.stopMoving()
    this.bubble.hide()
  }

  /** 每帧更新（由 ticker 调用） */
  update(): void {
    if (!this.isRunning) return

    // 同步朝向：UserAvatar 的 scale.set(AVATAR_SCALE) 会覆盖 spine.scale.x 为正数，
    // 导致 facing(=-1) 和 spine 实际朝向(=右) 不一致 → 倒着走。这里每帧检查并修正。
    const expectedScaleX = AVATAR_SCALE * this.facing
    if (Math.abs(this.spine.scale.x - expectedScaleX) > 0.001) {
      this.spine.scale.x = expectedScaleX
    }

    // 同步昵称位置（相对 spine root，NAME_TAG_Y 统一主角访客高度）
    if (this.nameTag) {
      this.nameTag.setAnchor(this.spine.x, this.spine.y + NAME_TAG_Y)
    }

    this.updatePhysics()
    this.updateStateMachine()
    this.bubble.update()

    // 活动超时检测
    if (this.activityEndsAt > 0 && Date.now() >= this.activityEndsAt) {
      this.activityEndsAt = 0
      void this.setActivity('idle', 'neutral')
    }

    // 同步位置到 GardenManager（节流：每 1 秒一次）
    // 内存快照每次都更新（保证 getSnapshot 拿最新位置），写库由 GardenManager 内部节流
    const now = performance.now()
    if (this.gardenManager && now - this._lastSyncAt > 1000) {
      this._lastSyncAt = now
      const screenPos = this.physicsSystem.physicsToScreen(
        this.body.position.x,
        this.body.position.y,
      )
      void this.gardenManager.updateAvatarPosition(screenPos.x, screenPos.y, this.facing)
    }
  }
  private _lastSyncAt = 0

  // ─── 活动状态外部接口 ────────────────────────────────────────

  /**
   * 外部强制设置化身活动（如 VisitorManager 触发 greeting/playing）
   * @param durationMs 持续时间，0 表示一直持续到下次 setActivity
   */
  async setActivity(activity: AvatarActivity, mood: AvatarMood = 'neutral', durationMs = 0): Promise<void> {
    this.currentActivity = activity
    this.currentMood = mood

    // 映射到 Spine 5 状态
    const spineState = this.activityToSpineState(activity)
    if (spineState) this.setState(spineState)

    // 显示气泡
    this.bubble.showForActivity(activity)

    // 持续时间
    this.activityEndsAt = durationMs > 0 ? Date.now() + durationMs : 0

    // 持久化到 GardenManager
    if (this.gardenManager) {
      await this.gardenManager.setAvatarActivity(activity, mood)
    }
  }

  getActivity(): AvatarActivity {
    return this.currentActivity
  }

  getMood(): AvatarMood {
    return this.currentMood
  }

  /**
   * 走到指定屏幕 X 坐标（公开，供外部调用如点击花盆后走到花盆边）。
   * 到达后执行 onArrived 回调（若提供），期间阻止随机决策打断。
   * @param targetX 目标屏幕 X 坐标
   * @param onArrived 到达后回调（在主线程同步调用 setActivity 后执行）
   */
  walkToTarget(targetX: number, onArrived?: () => void): void {
    this.isExternalWalkPending = true
    this.onArrivedCallback = onArrived ?? null
    this.walkTo(targetX)
    void this.setActivity('walking', 'neutral')
  }

  /** 设置头顶昵称（由 UserAvatar 从服务端 profile 获取 nickname 后传入） */
  setNickname(name: string): void {
    this.nameTag?.setText(name)
  }

  /** 活动 → Spine 5 状态映射 */
  private activityToSpineState(activity: AvatarActivity): AvatarState | null {
    switch (activity) {
      case 'idle':
      case 'reading':
      case 'resting':
      case 'watering':
      case 'harvesting':
      case 'planting':
      case 'photographing':
      case 'greeting':
      case 'playing':
      case 'chatting':
      case 'returning':
        return 'Idle'
      case 'walking':
        return 'Walk'
      case 'jumping':
        return 'Jump'
      case 'rolling':
        return 'Roll'
      case 'flying':
        return 'Fly'
      case 'visiting':
        // 外出中，桌面不显示，不播放动画
        return null
      default:
        return 'Idle'
    }
  }

  // ─── 行为循环 ────────────────────────────────────────────

  private scheduleNextDecision(): void {
    if (!this.isRunning) return
    // 3-6 秒随机间隔（基准 4s × 0.5~1.5 抖动，参考旧系统）
    const interval = 4000 * (0.5 + Math.random())
    this.behaviorTimer = setTimeout(() => {
      this.makeDecision()
      this.scheduleNextDecision()
    }, interval)
  }

  private makeDecision(): void {
    // 外部行走中（如走向花盆）不打断
    if (this.isExternalWalkPending) return
    // 社交/外部活动进行中时不打断
    if (
      this.currentActivity === 'playing' ||
      this.currentActivity === 'chatting' ||
      this.currentActivity === 'greeting' ||
      this.currentActivity === 'visiting' ||
      this.currentActivity === 'returning'
    ) {
      return
    }
    // 正在浇水/收获/种植/阅读/休息等活动中：让其完成
    if (this.activityEndsAt > 0 && Date.now() < this.activityEndsAt) return

    const action = this.chooseAction()
    this.executeAction(action)
  }

  private chooseAction(): BehaviorAction {
    const rand = Math.random()

    // 如果在空中，等落地再决策
    if (!this.physicsSystem.isOnGround(this.body)) {
      return { type: 'continue' }
    }

    if (rand < 0.40) {
      // 随机走到一个点
      const targetX = 50 + Math.random() * (window.innerWidth - 100)
      return { type: 'explore', targetX }
    }
    if (rand < 0.65) {
      return { type: 'idle', duration: 2000 + Math.random() * 3000 }
    }
    if (rand < 0.77) {
      // 休息（用户长时间无操作时也由 ActivityTracker 触发）
      return { type: 'rest' }
    }
    if (rand < 0.87) {
      // 阅读
      return { type: 'read' }
    }
    if (rand < 0.95) {
      // 浇花（如果有植物）
      return { type: 'water' }
    }
    if (rand < 0.98) {
      return { type: 'jump' }
    }
    return { type: 'roll' }
  }

  private async executeAction(action: BehaviorAction): Promise<void> {
    switch (action.type) {
      case 'explore':
        this.walkTo(action.targetX)
        await this.setActivity('walking', 'neutral')
        break
      case 'idle':
        this.stopMoving()
        this.setState('Idle')
        await this.setActivity('idle', 'neutral', action.duration)
        break
      case 'rest':
        this.stopMoving()
        this.setState('Idle')
        await this.setActivity('resting', 'sleepy', 8000 + Math.random() * 4000)
        break
      case 'read':
        this.stopMoving()
        this.setState('Idle')
        await this.setActivity('reading', 'focused', 10000 + Math.random() * 5000)
        break
      case 'water':
        this.stopMoving()
        this.setState('Idle')
        await this.setActivity('watering', 'focused', 3000)
        break
      case 'jump':
        this.doJump()
        await this.setActivity('jumping', 'happy', 800)
        break
      case 'roll':
        this.doRoll()
        await this.setActivity('rolling', 'happy', 1000)
        break
      case 'continue':
        // 保持当前行为
        break
    }
  }

  // ─── 物理控制 ────────────────────────────────────────────

  private walkTo(targetX: number): void {
    this.walkTargetX = targetX
    this.walkSpeedFactor = 0.4 + Math.random() * 0.6
    // 唤醒物理体（enableSleeping=true 时静止 body 会 sleep，setVelocity 无效）
    Matter.Sleeping.set(this.body, false)
    this.setState('Walk')
  }

  private doJump(): void {
    if (!this.physicsSystem.isOnGround(this.body)) return
    Matter.Sleeping.set(this.body, false)
    const vx = (Math.random() - 0.5) * 10
    Matter.Body.setVelocity(this.body, { x: vx, y: -22 })
    this.setState('Jump')
  }

  private doRoll(): void {
    if (!this.physicsSystem.isOnGround(this.body)) return
    Matter.Sleeping.set(this.body, false)
    const dir = Math.random() < 0.5 ? -1 : 1
    Matter.Body.setVelocity(this.body, { x: dir * 14, y: -8 })
    this.setState('Roll')
  }

  private stopMoving(): void {
    this.walkTargetX = null
    Matter.Body.setVelocity(this.body, { x: 0, y: this.body.velocity.y })
  }

  // ─── 每帧物理更新 ────────────────────────────────────────

  private updatePhysics(): void {
    // 社交/活动进行中时停止移动
    if (
      this.currentActivity === 'resting' ||
      this.currentActivity === 'reading' ||
      this.currentActivity === 'watering' ||
      this.currentActivity === 'harvesting' ||
      this.currentActivity === 'planting' ||
      this.currentActivity === 'photographing' ||
      this.currentActivity === 'playing' ||
      this.currentActivity === 'chatting' ||
      this.currentActivity === 'greeting'
    ) {
      this.stopMoving()
      return
    }

    const onGround = this.physicsSystem.isOnGround(this.body)
    if (!onGround) {
      // 在空中：限幅 + 朝向跟随速度
      this.clampVelocity()
      const vx = this.body.velocity.x
      if (Math.abs(vx) > 1) this.setFacing(vx > 0 ? 1 : -1)
      return
    }

    // 行走逻辑
    if (this.walkTargetX !== null && this.currentState === 'Walk') {
      const screenPos = this.physicsSystem.physicsToScreen(
        this.body.position.x,
        this.body.position.y
      )
      const dx = this.walkTargetX - screenPos.x

      if (Math.abs(dx) < 12) {
        // 到达目标
        this.stopMoving()
        this.setState('Idle')
        // 清除外部行走标志并触发到达回调
        this.isExternalWalkPending = false
        const cb = this.onArrivedCallback
        this.onArrivedCallback = null
        void this.setActivity('idle', 'neutral').then(() => {
          cb?.()
        })
      } else {
        const dir = dx > 0 ? 1 : -1
        this.setFacing(dir)
        // 确保物理体唤醒（sleeping body 不响应 setVelocity）
        Matter.Sleeping.set(this.body, false)
        const speed = this.walkBaseSpeed * this.walkSpeedFactor
        Matter.Body.setVelocity(this.body, {
          x: dir * speed,
          y: this.body.velocity.y,
        })
      }
    }

    this.clampVelocity()

    // 同步气泡锚点到 spine root（与访客统一坐标系）
    this.bubble.setAnchor(this.spine.x, this.spine.y)
  }

  private clampVelocity(): void {
    const vx = this.body.velocity.x
    const vy = this.body.velocity.y
    const clampedX = Math.max(-this.maxSpeedX, Math.min(this.maxSpeedX, vx))
    const clampedY = Math.max(-30, Math.min(30, vy))
    if (clampedX !== vx || clampedY !== vy) {
      Matter.Body.setVelocity(this.body, { x: clampedX, y: clampedY })
    }
  }

  // ─── 状态机 ──────────────────────────────────────────────

  private updateStateMachine(): void {
    const isOnGround = this.physicsSystem.isOnGround(this.body)
    const isMoving = Math.abs(this.body.velocity.x) > 0.5

    // 社交/活动进行中时不打断状态机
    if (this.currentActivity !== 'walking' && this.currentActivity !== 'idle' &&
        this.currentActivity !== 'jumping' && this.currentActivity !== 'rolling' &&
        this.currentActivity !== 'flying') {
      return
    }

    // 在空中且不是 Jump/Fly/Roll → Fly
    if (!isOnGround && this.currentState !== 'Jump' && this.currentState !== 'Fly' && this.currentState !== 'Roll') {
      this.setState('Fly')
      return
    }
    // 落地且在 Fly 状态 → Idle/Walk
    if (isOnGround && this.currentState === 'Fly') {
      this.setState(isMoving ? 'Walk' : 'Idle')
      return
    }
    // Jump/Roll 落地后由定时器转 Idle（见 setState 中的 setTimeout）
  }

  private setState(state: AvatarState): void {
    if (this.currentState === state) return
    this.currentState = state

    switch (state) {
      case 'Idle':
        this.playAnimation('Idle', true)
        break
      case 'Walk':
        this.playAnimation('Walk', true)
        break
      case 'Jump':
        this.playAnimation('Jump', false)
        // 跳跃动画约 800ms 后自动转 Fly/Idle
        setTimeout(() => {
          if (this.currentState === 'Jump') {
            this.setState(this.physicsSystem.isOnGround(this.body) ? 'Idle' : 'Fly')
          }
        }, 800)
        break
      case 'Fly':
        this.playAnimation('Fly', true)
        break
      case 'Roll':
        this.playAnimation('Roll', false)
        // 翻滚动画约 1000ms 后自动转 Idle
        setTimeout(() => {
          if (this.currentState === 'Roll') {
            this.setState('Idle')
          }
        }, 1000)
        break
    }
  }

  // ─── 动画播放 ────────────────────────────────────────────

  /**
   * 播放动画（三级匹配：精确 → 模糊包含 → 回退首个 idle）
   * 参考旧系统 animation.ts 的 playCandidates 逻辑
   */
  private playAnimation(name: string, loop: boolean): void {
    const track = this.findAndPlayAnimation(name, loop)
    if (!track && this.availableAnimations.length > 0) {
      // 回退到 Idle
      this.spine.state.setAnimation(0, 'Idle', true)
    }
  }

  private findAndPlayAnimation(name: string, loop: boolean): boolean {
    const anims = this.availableAnimations
    if (anims.length === 0) return false

    // 精确匹配
    let anim = anims.find(a => a === name)
    // 模糊包含
    if (!anim) anim = anims.find(a => a.toLowerCase().includes(name.toLowerCase()))
    // 回退首个 idle
    if (!anim) anim = anims.find(a => a.toLowerCase().includes('idle'))

    if (anim) {
      this.spine.state.setAnimation(0, anim, loop)
      return true
    }
    return false
  }

  // ─── 朝向 ────────────────────────────────────────────────

  private setFacing(dir: 1 | -1): void {
    if (this.facing === dir) return
    this.facing = dir
    // 用固定 AVATAR_SCALE 而非 Math.abs(scale.x) —— 防止 UserAvatar 的 scale.set() 覆盖后取到错误值
    this.spine.scale.x = AVATAR_SCALE * dir
  }

  // ─── 销毁 ────────────────────────────────────────────────

  destroy(): void {
    this.stop()
    this.bubble.destroy()
    this.nameTag?.destroy()
    this.nameTag = null
  }
}

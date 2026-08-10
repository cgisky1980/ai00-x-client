import Matter from 'matter-js'
import { storage } from '../storage'

export const CollisionCategories = {
    PET: 0x0001,
    PLATFORM: 0x0002,
    BOUNDARY: 0x0004,
    GROUND: 0x0008,
}

export const PetCollisionMasks = {
    DEFAULT: CollisionCategories.PLATFORM | CollisionCategories.GROUND | CollisionCategories.BOUNDARY,
    AIRBORNE: CollisionCategories.GROUND | CollisionCategories.BOUNDARY,
}

export interface Platform {
    id: string
    x: number
    y: number
    width: number
    height: number
    type: 'category' | 'shortcut' | 'widget'
    body?: Matter.Body
}

export interface WaterZone {
    x: number
    y: number
    width: number
    height: number
    flowSpeed: number
    flowDirection: number
}

export interface PhysicsConfig {
    gravity: { x: number, y: number }
    groundHeight: number
    enableSleeping: boolean
    debug: boolean
    groundYOffset?: number
    screenWallThickness?: number
    screenWallInsetTop?: number
    screenWallInsetSide?: number
}

/**
 * 物理系统管理器
 * 负责管理Matter.js引擎、世界、碰撞体等
 */
export class PhysicsSystem {
    private engine: Matter.Engine
    private world: Matter.World
    private config: PhysicsConfig
    private groundBody: Matter.Body | null = null
    private topWallBody: Matter.Body | null = null
    private leftWallBody: Matter.Body | null = null
    private rightWallBody: Matter.Body | null = null
    private safetyNetBody: Matter.Body | null = null
    private vrmLegsBounds: { minX: number, maxX: number, minY: number, maxY: number } | null = null
    private platforms: Map<string, Platform> = new Map()
    private waterZones: WaterZone[] = []
    private isWaterFrozen: boolean = false
    // KV storage 监听器清理函数（替代 'storage' 事件监听器）
    private unlistenKv: (() => void) | null = null

    private screenWidth: number = window.innerWidth
    private screenHeight: number = window.innerHeight

    private windowOffset: { x: number, y: number } = { x: 0, y: 0 }

    constructor(config?: Partial<PhysicsConfig>) {
        // 默认配置
        this.config = {
            gravity: { x: 0, y: 1.0 },
            groundHeight: 48,  // 默认任务栏高度
            enableSleeping: true,
            debug: false,
            ...config
        }

        // 创建Matter.js引擎
        this.engine = Matter.Engine.create({
            gravity: this.config.gravity,
            enableSleeping: this.config.enableSleeping,
            positionIterations: 12,
            velocityIterations: 12
        })

        this.world = this.engine.world

        // 初始化地面
        this.createGround()

        this.createScreenWalls()

        // 监听窗口大小变化
        window.addEventListener('resize', this.handleResize.bind(this))
        
        // 启动VRM障碍物监听
        this.startVRMListener()

        // 设置碰撞事件监听
        this.setupCollisionEvents()
    }

    private setupCollisionEvents() {
        // 监听碰撞开始事件
        Matter.Events.on(this.engine, 'collisionStart', (event) => {
            this.handleSafetyNetCollision(event.pairs)
        })

        // 监听碰撞持续事件（防止宠物停留在安全网上）
        Matter.Events.on(this.engine, 'collisionActive', (event) => {
            this.handleSafetyNetCollision(event.pairs)
        })
    }

    private handleSafetyNetCollision(pairs: Matter.Pair[]) {
        for (const pair of pairs) {
            const bodyA = pair.bodyA
            const bodyB = pair.bodyB

            // 检查是否涉及安全网
            if (bodyA.label === 'safety_net' || bodyB.label === 'safety_net') {
                const petBody = bodyA.label === 'pet' ? bodyA : (bodyB.label === 'pet' ? bodyB : null)
                
                if (petBody) {
                    // 施加向上的弹力
                    // 直接设置向上的速度，确保能弹起来
                    // 之前 restitution = 1.5 可能因为物理步长或睡眠问题不够稳定
                    // 强制给一个向上的速度
                    Matter.Body.setVelocity(petBody, {
                        x: petBody.velocity.x,
                        y: -25 // 足够大的向上速度，让它弹回地面以上
                    })
                    
                    // 唤醒刚体，防止它因为 sleeping 而不反弹
                    Matter.Sleeping.set(petBody, false)
                }
            }
        }
    }

    private startVRMListener() {
        if (typeof window === 'undefined') return

        // 监听 KV storage 变更（跨 webview 同步，替代 'storage' 事件）
        storage.onChanged((e) => {
            if (e.key === 'ai00.overlay.vrm_boundaries' && e.value) {
                try {
                    this.updateVRMObstacles(JSON.parse(e.value))
                } catch (err) {
                    console.warn('Failed to parse VRM boundaries:', err)
                }
            }
        }).then((fn) => {
            this.unlistenKv = fn
        }).catch(() => {})

        // Initial check (async load from storage)
        storage.get('ai00.overlay.vrm_boundaries').then((init) => {
            if (init) {
                try { this.updateVRMObstacles(JSON.parse(init)) } catch {}
            }
        }).catch(() => {})
    }

    updateVRMObstacles(data: any) {
        // Just update the bounds data, do NOT create a physics body
        if (data && data.legs) {
            const { x, y, width, height } = data.legs
            
            // Store bounds in physics coordinates for checking
            // But wait, checking is easier in screen coords if we want to filter logic
            // Let's store in Screen Coords for isPointBlocked (which takes screen coords)
            // Or Physics coords? isPointBlocked takes screen coords.
            
            // Let's store the SCREEN bounds directly to avoid conversion issues during check
            this.vrmLegsBounds = {
                minX: x,
                maxX: x + width,
                minY: y,
                maxY: y + height
            }
        } else {
            this.vrmLegsBounds = null
        }
    }

    /**
     * 检查点是否被障碍物阻挡 (Screen Coordinates)
     * 用于 AI 决策时不把目标定在 VRM 区域
     * @param screenX 屏幕X坐标
     * @param screenY 屏幕Y坐标 (可选)
     * @param ignoreY 是否忽略Y轴检查 (默认false)
     */
    isPointBlocked(screenX: number, screenY: number, ignoreY: boolean = false): boolean {
        if (this.vrmLegsBounds) {
             const xBlocked = screenX >= this.vrmLegsBounds.minX && screenX <= this.vrmLegsBounds.maxX
             if (ignoreY) return xBlocked
             
             // Y in screen coords is 0 at top.
             return xBlocked &&
                    screenY >= this.vrmLegsBounds.minY &&
                    screenY <= this.vrmLegsBounds.maxY
        }
        return false
    }

    /**
     * 检查X轴是否在VRM区域内 (忽略Y轴)
     */
    isVRMBlockedX(screenX: number): boolean {
        return this.isPointBlocked(screenX, 0, true)
    }

    getVRMLegsBounds(): { minX: number, maxX: number, minY: number, maxY: number } | null {
        return this.vrmLegsBounds
    }

    /**
     * 更新地面地形
     * @param surfacePoints 地面表面点集合（屏幕坐标）
     */
    updateGroundTerrain(surfacePoints: { x: number, y: number }[]): void {
        if (!surfacePoints || surfacePoints.length < 2) return

        const parts: Matter.Body[] = []
        // 足够深以防穿透
        const rectHeight = 2000
        let maxPointY = -Infinity

        for (let i = 0; i < surfacePoints.length - 1; i++) {
            const p1 = surfacePoints[i]
            const p2 = surfacePoints[i + 1]
            maxPointY = Math.max(maxPointY, p1.y, p2.y)

            // Use rectangle instead of fromVertices to avoid convex hull precision issues
            // that cause gaps between adjacent trapezoids
            const segWidth = p2.x - p1.x
            const avgY = (p1.y + p2.y) / 2
            const centerY = avgY + rectHeight / 2
            const slopeAngle = Math.atan2(p2.y - p1.y, segWidth)

            const rect = Matter.Bodies.rectangle(
                (p1.x + p2.x) / 2,
                centerY,
                Math.hypot(segWidth, p2.y - p1.y), // diagonal length ensures full coverage
                rectHeight,
                {
                    isStatic: true,
                    render: { visible: this.config.debug },
                    angle: slopeAngle,
                    collisionFilter: {
                        category: CollisionCategories.GROUND,
                        mask: CollisionCategories.PET | CollisionCategories.BOUNDARY
                    }
                }
            )

            if (rect) {
                parts.push(rect)
            }
        }

        if (parts.length > 0) {
            const newGroundBody = Matter.Body.create({
                parts: parts,
                isStatic: true,
                label: 'ground',
                friction: 0,
                frictionStatic: 0,
                restitution: 0.6,
                collisionFilter: {
                    category: CollisionCategories.GROUND,
                    mask: CollisionCategories.PET | CollisionCategories.BOUNDARY
                }
            })

            // Add new ground BEFORE removing old to avoid gap where pets can fall through
            Matter.World.add(this.world, newGroundBody)
            if (this.groundBody) {
                Matter.World.remove(this.world, this.groundBody)
            }
            this.groundBody = newGroundBody

            // 创建安全网 (Safety Net)
            this.createSafetyNet(maxPointY)
        }
    }

    /**
     * 创建安全网 - 防止宠物掉落
     */
    private createSafetyNet(lowestGroundY: number): void {
        if (this.safetyNetBody) {
            Matter.World.remove(this.world, this.safetyNetBody)
        }

        // 在最低点下方较远的位置，防止误触
        // 地面厚度通常为 2000px (terrain)
        // 设置在地面表面下方 2500px 处，确保只有真正掉下去才会触发
        const y = lowestGroundY + 2500 
        const width = this.screenWidth * 10 // 足够宽
        const height = 100

        this.safetyNetBody = Matter.Bodies.rectangle(
            this.screenWidth / 2,
            y,
            width,
            height,
            {
                isStatic: true,
                label: 'safety_net',
                friction: 0.1,
                frictionStatic: 0,
                restitution: 1.5, // 强弹性，把宠物弹回去
                collisionFilter: {
                    category: CollisionCategories.BOUNDARY,
                    mask: CollisionCategories.PET
                }
            }
        )

        Matter.World.add(this.world, this.safetyNetBody)
    }

    /**
     * 创建地面碰撞体（任务栏区域）
     */
    private createGround(): void {
        // 如果已经有自定义地形，不重置为默认矩形
        if (this.groundBody && this.groundBody.parts.length > 1) {
             return;
        }

        // Previous: Center Y = screenHeight - groundHeight/2
        // Top Surface Y = screenHeight - groundHeight
        const topSurfaceY = this.screenHeight - this.config.groundHeight + (this.config.groundYOffset ?? 0)
        
        // Make it 2000px thick
        const thickness = 2000
        const centerY = topSurfaceY + thickness / 2

        this.groundBody = Matter.Bodies.rectangle(
            this.screenWidth / 2,
            centerY,
            this.screenWidth,
            thickness,
            {
                isStatic: true,
                label: 'ground',
                friction: 0,
                frictionStatic: 0,
                restitution: 0,
                collisionFilter: {
                    category: CollisionCategories.GROUND,
                    mask: CollisionCategories.PET | CollisionCategories.BOUNDARY
                }
            }
        )

        Matter.World.add(this.world, this.groundBody)

        // 为默认地面也添加安全网 (based on top surface Y)
        this.createSafetyNet(topSurfaceY)
    }

    private createScreenWalls(): void {
        // Top wall: make it very thick and place it ABOVE the screen to prevent tunneling/sitting on top
        const topThickness = 2000 
        const sideThickness = 2000 // Thick side walls too
        const insetTop = this.config.screenWallInsetTop ?? 0
        const insetSide = this.config.screenWallInsetSide ?? 0

        // Place the bottom edge of the top wall at 'insetTop'
        // Center Y = insetTop - topThickness / 2
        this.topWallBody = Matter.Bodies.rectangle(
            this.screenWidth / 2,
            insetTop - topThickness / 2,
            this.screenWidth * 3, // Make it wider too
            topThickness,
            {
                isStatic: true,
                label: 'wall_top',
                friction: 0.0, // No friction to prevent sticking
                frictionStatic: 0,
                restitution: 0.5, // Bouncy
                collisionFilter: {
                    category: CollisionCategories.BOUNDARY,
                    mask: CollisionCategories.PET
                }
            }
        )

        // Left wall
        // Inner edge at `insetSide`
        // Center X = insetSide - sideThickness / 2
        this.leftWallBody = Matter.Bodies.rectangle(
            insetSide - sideThickness / 2,
            this.screenHeight / 2,
            sideThickness,
            this.screenHeight * 3, // Taller
            {
                isStatic: true,
                label: 'wall_left',
                friction: 0.0,
                frictionStatic: 0,
                restitution: 0.5,
                collisionFilter: {
                    category: CollisionCategories.BOUNDARY,
                    mask: CollisionCategories.PET
                }
            }
        )

        // Right wall
        // Inner edge at `screenWidth - insetSide`
        // Center X = (screenWidth - insetSide) + sideThickness / 2
        this.rightWallBody = Matter.Bodies.rectangle(
            (this.screenWidth - insetSide) + sideThickness / 2,
            this.screenHeight / 2,
            sideThickness,
            this.screenHeight * 3, // Taller
            {
                isStatic: true,
                label: 'wall_right',
                friction: 0.0,
                frictionStatic: 0,
                restitution: 0.5,
                collisionFilter: {
                    category: CollisionCategories.BOUNDARY,
                    mask: CollisionCategories.PET
                }
            }
        )

        Matter.World.add(this.world, [this.topWallBody, this.leftWallBody, this.rightWallBody])
    }

    /**
     * 设置窗口偏移
     * @param offset 窗口相对于屏幕的偏移量
     */
    setWindowOffset(offset: { x: number, y: number }): void {
        this.windowOffset = offset
    }

    /**
     * 获取窗口偏移
     */
    getWindowOffset(): { x: number, y: number } {
        return { ...this.windowOffset }
    }

    /**
     * 屏幕坐标转物理世界坐标
     */
    screenToPhysics(screenX: number, screenY: number): { x: number, y: number } {
        return {
            x: screenX - this.windowOffset.x,
            y: screenY - this.windowOffset.y
        }
    }

    /**
     * 物理世界坐标转屏幕坐标
     */
    physicsToScreen(physicsX: number, physicsY: number): { x: number, y: number } {
        return {
            x: physicsX + this.windowOffset.x,
            y: physicsY + this.windowOffset.y
        }
    }

    /**
     * 获取地面顶边的屏幕坐标Y
     */
    getGroundTopScreenY(): number {
        if (this.groundBody) {
            const topYPhysics = this.groundBody.bounds.min.y
            const sp = this.physicsToScreen(0, topYPhysics)
            return sp.y
        }
        return this.screenHeight - this.config.groundHeight + (this.config.groundYOffset ?? 0)
    }

    /**
     * 创建或更新平台碰撞体
     * @param platform 平台数据
     */
    addOrUpdatePlatform(platform: Platform): void {
        // 如果平台已存在，先移除旧的
        if (this.platforms.has(platform.id)) {
            this.removePlatform(platform.id)
        }

        // 转换为物理坐标
        const physicsPos = this.screenToPhysics(platform.x, platform.y + platform.height / 2)

        // 创建矩形静态刚体，添加圆角减少边缘穿透
        const cornerRadius = Math.min(8, platform.height / 4)
        const body = Matter.Bodies.rectangle(
            physicsPos.x,
            physicsPos.y,
            platform.width,
            platform.height,
            {
                isStatic: true,
                label: `platform_${platform.id}`,
                friction: 0.8,
                restitution: 0.1,
                chamfer: { radius: cornerRadius },
                collisionFilter: {
                    category: CollisionCategories.PLATFORM,
                    mask: CollisionCategories.PET
                }
            }
        )

        platform.body = body
        this.platforms.set(platform.id, platform)
        Matter.World.add(this.world, body)
    }

    /**
     * 移除平台碰撞体
     * @param platformId 平台ID
     */
    removePlatform(platformId: string): void {
        const platform = this.platforms.get(platformId)
        if (platform && platform.body) {
            Matter.World.remove(this.world, platform.body)
            this.platforms.delete(platformId)
        }
    }

    /**
     * 获取所有平台
     */
    getPlatforms(): Platform[] {
        return Array.from(this.platforms.values())
    }

    /**
     * 创建宠物刚体（圆形动态刚体）
     * @param x X坐标（屏幕坐标）
     * @param y Y坐标（屏幕坐标）
     * @param radius 半径
     * @returns Matter.Body
     */
    createPetBody(x: number, y: number, radius: number = 50): Matter.Body {
        const physicsPos = this.screenToPhysics(x, y)

        const body = Matter.Bodies.circle(
            physicsPos.x,
            physicsPos.y,
            radius,
            {
                density: 0.001,
                friction: 0,
                frictionStatic: 0,
                frictionAir: 0.01, // 降低空气阻力 (0.05 -> 0.01)，让跳跃高度更符合预期
                restitution: 0.0, // 增加宠物弹性
                label: 'pet',
                collisionFilter: {
                    category: CollisionCategories.PET,
                    mask: PetCollisionMasks.DEFAULT
                }
            }
        )

        Matter.World.add(this.world, body)
        return body
    }

    /**
     * 创建花盆刚体（矩形，固定旋转不翻倒）
     * @param x 屏幕坐标 X（中心）
     * @param y 屏幕坐标 Y（中心）
     * @param width 宽
     * @param height 高
     * @returns Matter.Body
     */
    createPotBody(x: number, y: number, width: number, height: number): Matter.Body {
        const physicsPos = this.screenToPhysics(x, y)
        const body = Matter.Bodies.rectangle(
            physicsPos.x,
            physicsPos.y,
            width,
            height,
            {
                density: 0.002,
                friction: 0.95,
                frictionStatic: 1.5,
                frictionAir: 0.1,
                restitution: 0.0,
                inertia: Infinity, // 固定旋转，不翻倒
                label: 'pot',
                collisionFilter: {
                    category: CollisionCategories.PET,
                    // 花盆只与地面和边界碰撞，穿过平台和其他花盆（防重叠由 PotRenderer 手动处理）
                    mask: CollisionCategories.GROUND | CollisionCategories.BOUNDARY
                },
                chamfer: { radius: Math.min(4, height / 4) }
            }
        )
        Matter.World.add(this.world, body)
        return body
    }

    /**
     * 将动态刚体转为静态（落地后调用，停止物理模拟）
     */
    setBodyStatic(body: Matter.Body): void {
        Matter.Body.setStatic(body, true)
    }

    /**
     * 移除刚体
     * @param body 要移除的刚体
     */
    removeBody(body: Matter.Body): void {
        Matter.World.remove(this.world, body)
    }

    /**
     * 检测刚体是否在地面或平台上
     * @param body 要检测的刚体
     * @returns 是否接触地面或平台
     */
    isOnGround(body: Matter.Body, includePlatforms: boolean = true): boolean {
        const candidates = [
            this.groundBody!,
            ...(includePlatforms ? Array.from(this.platforms.values()).map(p => p.body!).filter(b => b) : [])
        ].filter(b => b)

        const collisions = Matter.Query.collides(body, candidates)
        if (collisions.length > 0) return true

        const radius = (body.bounds.max.x - body.bounds.min.x) / 2
        const footY = body.position.y + radius

        if (this.groundBody) {
            const gTop = this.groundBody.bounds.min.y
            if (footY >= gTop - 8) return true
        }

        if (includePlatforms) {
        for (const p of this.platforms.values()) {
            const b = p.body
            if (!b) continue
            const withinX = body.position.x >= b.bounds.min.x && body.position.x <= b.bounds.max.x
            const topY = b.bounds.min.y
            if (withinX && Math.abs(footY - topY) < 10) return true
        }
        }

        return false
    }

    /**
     * 获取当前站立的平台
     * @param body 宠物刚体
     * @returns Platform | null
     */
    getCurrentPlatform(body: Matter.Body): Platform | null {
        const platformBodies = Array.from(this.platforms.values())
            .map(p => ({ platform: p, body: p.body! }))
            .filter(p => p.body)

        for (const { platform, body: platformBody } of platformBodies) {
            const collisions = Matter.Query.collides(body, [platformBody])
            if (collisions.length > 0) {
                const collision = collisions[0]
                if (!collision) continue

                const normal = collision.normal || (collision as any).collision?.normal

                if (!normal) continue

                // 法线向上表示站在平台上
                if (normal.y < -0.5) {
                    return platform
                }
            }
        }

        return null
    }

    addWaterZone(zone: WaterZone): void {
        this.waterZones.push(zone)
    }

    clearWaterZones(): void {
        this.waterZones = []
    }

    setWaterFrozen(frozen: boolean): void {
        this.isWaterFrozen = frozen
    }

    isInWater(body: Matter.Body): WaterZone | null {
        if (this.isWaterFrozen || this.waterZones.length === 0) return null

        const pos = body.position
        const screenPos = this.physicsToScreen(pos.x, pos.y)
        const radius = (body.bounds.max.x - body.bounds.min.x) / 2

        for (const zone of this.waterZones) {
            if (screenPos.x >= zone.x - radius &&
                screenPos.x <= zone.x + zone.width + radius &&
                screenPos.y >= zone.y - radius &&
                screenPos.y <= zone.y + zone.height + radius) {
                return zone
            }
        }
        return null
    }

    isNearBank(body: Matter.Body, zone: WaterZone): boolean {
        const pos = body.position
        const screenPos = this.physicsToScreen(pos.x, pos.y)
        const bankThreshold = 30

        const nearLeftBank = screenPos.x < zone.x + bankThreshold
        const nearRightBank = screenPos.x > zone.x + zone.width - bankThreshold

        return nearLeftBank || nearRightBank
    }

    private applyWaterPhysics(): void {
        if (this.isWaterFrozen) return

        const bodies: Matter.Body[] = (this.world as any).bodies || []

        for (const body of bodies) {
            if (body.label !== 'pet') continue

            const waterZone = this.isInWater(body)
            if (!waterZone) continue

            const buoyancy = -0.003
            const drag = 0.02
            const flowForce = waterZone.flowSpeed * waterZone.flowDirection * 0.0005

            Matter.Body.applyForce(body, body.position, {
                x: flowForce,
                y: buoyancy
            })

            const velocity = body.velocity
            Matter.Body.setVelocity(body, {
                x: velocity.x * (1 - drag),
                y: velocity.y * (1 - drag * 0.5)
            })

            if (this.isNearBank(body, waterZone)) {
                const pos = body.position
                const screenPos = this.physicsToScreen(pos.x, pos.y)
                let helpForceX = 0

                if (screenPos.x < waterZone.x + 30) {
                    helpForceX = -0.002
                } else if (screenPos.x > waterZone.x + waterZone.width - 30) {
                    helpForceX = 0.002
                }

                Matter.Body.applyForce(body, body.position, {
                    x: helpForceX,
                    y: -0.001
                })
            }
        }
    }

    update(delta: number): void {
        const safeDelta = Math.min(delta * 1000, 16.66)
        Matter.Engine.update(this.engine, safeDelta)

        this.applyWaterPhysics()
    }

    wakePets(): void {
        const bodies: Matter.Body[] = (this.world as any).bodies || []
        for (const b of bodies) {
            if (b.label === 'pet') {
                Matter.Sleeping.set(b, false)
                Matter.Body.setStatic(b, false)
            }
        }
    }

    /**
     * 处理窗口大小变化
     */
    private handleResize(): void {
        this.screenWidth = window.innerWidth
        this.screenHeight = window.innerHeight

        // 重新创建地面
        if (this.groundBody) {
            Matter.World.remove(this.world, this.groundBody)
        }
        this.createGround()

        if (this.topWallBody) {
            Matter.World.remove(this.world, this.topWallBody)
            this.topWallBody = null
        }
        if (this.leftWallBody) {
            Matter.World.remove(this.world, this.leftWallBody)
            this.leftWallBody = null
        }
        if (this.rightWallBody) {
            Matter.World.remove(this.world, this.rightWallBody)
            this.rightWallBody = null
        }
        this.createScreenWalls()
    }

    /**
     * 获取引擎实例（用于调试）
     */
    getEngine(): Matter.Engine {
        return this.engine
    }

    /**
     * 获取世界实例（用于调试）
     */
    getWorld(): Matter.World {
        return this.world
    }

    getSafeBoundsForRadius(radius: number): { minX: number, maxX: number, minY: number, maxY: number } {
        const thickness = this.config.screenWallThickness ?? 24
        const insetTop = this.config.screenWallInsetTop ?? 0
        const insetSide = this.config.screenWallInsetSide ?? 0
        const groundTopY = this.screenHeight - this.config.groundHeight + (this.config.groundYOffset ?? 0)
        const minX = insetSide + thickness + radius
        const maxX = this.screenWidth - insetSide - thickness - radius
        const minY = insetTop + thickness + radius
        const maxY = groundTopY - radius
        return { minX, maxX, minY, maxY }
    }

    /**
     * 获取当前物理边界的边距配置（用于设置窗口工作区）
     */
    getBoundaryMargins(): { left: number, top: number, right: number, bottom: number } {
        const thickness = this.config.screenWallThickness ?? 24
        const insetTop = this.config.screenWallInsetTop ?? 0
        const insetSide = this.config.screenWallInsetSide ?? 0
        
        // 计算各边的保留距离
        const left = insetSide + thickness
        const right = insetSide + thickness
        const top = insetTop + thickness
        // 底部边距 = 地面高度 - 偏移量 (即地面顶部到屏幕底部的距离)
        const bottom = this.config.groundHeight - (this.config.groundYOffset ?? 0)

        return { left, top, right, bottom }
    }

    /**
     * 清理资源
     */
    destroy(): void {
        window.removeEventListener('resize', this.handleResize.bind(this))
        try { this.unlistenKv?.() } catch { }
        this.unlistenKv = null
        Matter.Engine.clear(this.engine)
        Matter.World.clear(this.world, false)
    }
}

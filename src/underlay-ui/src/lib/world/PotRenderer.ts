// ========================================================================
// 花盆渲染器（PotRenderer）
// ========================================================================
// 职责：
// - 监听 GardenManager 事件，自动创建/销毁花盆 Sprite
// - 用 PIXI.Graphics 渲染花盆形状
// - 接入物理系统：新放置的花盆从点击位置下落到地面，固定旋转不翻倒
// - 落地后转静态，坐标持久化到 GardenManager
// - 点击交互由 GardenToolbar 的 window click + getPotAt 处理
// ========================================================================

import * as PIXI from 'pixi.js';
import * as Matter from 'matter-js';
import type { GardenManager } from './GardenManager';
import type { PhysicsSystem } from '../physics/PhysicsSystem';
import type { Pot, GardenEventListener } from './types';

/** 花盆物理刚体尺寸 */
const POT_PHYSICS_WIDTH = 40;
const POT_PHYSICS_HEIGHT = 40;
/** 连续静止帧数阈值 */
const SETTLE_FRAMES = 8;

/** 花盆渲染节点 */
interface PotNode {
    potId: string;
    container: PIXI.Container;
    graphic: PIXI.Graphics;
    /** 高亮边框（hover 时显示） */
    highlight: PIXI.Graphics;
    /** 物理刚体（null 表示已转静态或无物理） */
    body: Matter.Body | null;
    /** 是否已落地静止 */
    isSettled: boolean;
    /** 连续低速帧计数 */
    lowVelFrames: number;
}

export class PotRenderer {
    private app: PIXI.Application;
    private gardenManager: GardenManager;
    private physicsSystem: PhysicsSystem | null;
    private layer: PIXI.Container;
    private nodes: Map<string, PotNode> = new Map();
    private unsubscribe: (() => void) | null = null;
    private isInitialized = false;

    // ─── 拖动状态 ───
    private dragNode: PotNode | null = null;
    private dragOffsetX = 0;
    private dragOffsetY = 0;
    private dragMoved = false;
    /** 拖动刚结束的标志（mouseup 后置 true，click 事件后清除） */
    private suppressClick = false;

    /** 是否正在拖动（供外部判断是否应忽略 click 事件） */
    get isDragging(): boolean {
        return this.dragNode !== null && this.dragMoved;
    }

    /** 拖动刚结束，下一个 click 事件应被忽略 */
    get justDragged(): boolean {
        return this.suppressClick;
    }

    /** 点击花盆回调（potId, pot, screenX, screenY） */
    onClick?: (potId: string, pot: Pot, screenX: number, screenY: number) => void;
    /** 右键花盆回调 */
    onContext?: (potId: string, pot: Pot, screenX: number, screenY: number) => void;

    constructor(
        app: PIXI.Application,
        gardenManager: GardenManager,
        physicsSystem?: PhysicsSystem | null,
        parentLayer?: PIXI.Container,
    ) {
        this.app = app;
        this.gardenManager = gardenManager;
        this.physicsSystem = physicsSystem ?? null;
        this.layer = parentLayer ?? new PIXI.Container();
        this.layer.zIndex = 5; // 花盆层：地面(-10) 之后，植物(8) 之前
        if (!parentLayer) {
            this.app.stage.addChild(this.layer);
        }
    }

    // ─── 生命周期 ────────────────────────────────────────────────

    start(): void {
        if (this.isInitialized) return;
        this.isInitialized = true;

        // 渲染当前所有已存在的花盆（已持久化的位置，不再下落）
        const pots = this.gardenManager.getSnapshot().pots;
        for (const pot of pots) {
            this.createNode(pot, false); // false = 不创建物理体，直接放在存储位置
        }

        // 订阅 GardenManager 事件
        const listener: GardenEventListener = (event) => {
            if (event.type === 'plant:planted') {
                this.updateNodeAppearance(event.plant.id);
            } else if (event.type === 'plant:harvested') {
                this.updateNodeAppearance(event.plantId);
            }
        };
        this.unsubscribe = this.gardenManager.on(listener);

        // 注册 ticker：每帧同步物理位置到渲染
        this.app.ticker.add(this.tickPhysics);

        // 注册拖动事件（捕获阶段，先于 GardenToolbar 的 click）
        window.addEventListener('mousedown', this.onDragStart, true);
        window.addEventListener('mousemove', this.onDragMove);
        window.addEventListener('mouseup', this.onDragEnd);
    }

    stop(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        this.app.ticker.remove(this.tickPhysics);
        window.removeEventListener('mousedown', this.onDragStart, true);
        window.removeEventListener('mousemove', this.onDragMove);
        window.removeEventListener('mouseup', this.onDragEnd);
        for (const [, node] of this.nodes) {
            this.destroyNode(node);
        }
        this.nodes.clear();
        this.isInitialized = false;
    }

    /** 每帧物理同步回调 */
    private tickPhysics = (): void => {
        this.update();
    };

    // ─── 节点管理 ────────────────────────────────────────────────

    /**
     * 创建花盆渲染节点
     * @param pot 花盆数据
     * @param withPhysics 是否创建物理刚体（新放置的花盆为 true，已存在的为 false）
     */
    private createNode(pot: Pot, withPhysics: boolean = true): PotNode {
        if (this.nodes.has(pot.id)) return this.nodes.get(pot.id)!;

        // 新放置的花盆：检查与已落地花盆的重叠，调整 x 位置
        if (withPhysics) {
            pot.x = this.findNonOverlappingX(pot.x);
        }

        const container = new PIXI.Container();
        container.x = pot.x;
        container.y = pot.y;

        // 高亮边框（由 highlightPot/clearHighlight 手动控制）
        const highlight = new PIXI.Graphics();
        highlight.visible = false;
        container.addChild(highlight);

        // 用 Graphics 画一个简单花盆形状（花盆中心约在 y=0，底部在 y=15）
        const text = new PIXI.Graphics();
        // 花盆主体（梯形）
        text.moveTo(-18, -20);
        text.lineTo(18, -20);
        text.lineTo(14, 15);
        text.lineTo(-14, 15);
        text.closePath();
        text.fill({ color: 0xc0855e });
        text.stroke({ color: 0x8b5a3c, width: 2 });
        // 花盆口（椭圆顶部）
        text.ellipse(0, -20, 20, 5);
        text.fill({ color: 0xa07050 });
        text.stroke({ color: 0x8b5a3c, width: 1.5 });
        // 土壤
        text.ellipse(0, -18, 16, 3);
        text.fill({ color: 0x5a3a20 });
        // 如果有植物，画一个小芽
        if (pot.plantId) {
            text.moveTo(0, -18);
            text.lineTo(0, -32);
            text.stroke({ color: 0x4a7c3a, width: 2 });
            text.circle(0, -34, 4);
            text.fill({ color: 0x6abf5a });
        }
        container.addChild(text);

        this.layer.addChild(container);

        // 创建物理刚体（新放置的花盆从点击位置下落）
        // 刚体底部 = 花盆中心，即花盆下半部分埋在土里
        let body: Matter.Body | null = null;
        let isSettled = false;
        if (withPhysics && this.physicsSystem) {
            // 刚体中心在花盆中心上方 H/2，使刚体底部对齐花盆中心
            const bodyCenterY = pot.y - POT_PHYSICS_HEIGHT / 2;
            body = this.physicsSystem.createPotBody(
                pot.x, bodyCenterY,
                POT_PHYSICS_WIDTH, POT_PHYSICS_HEIGHT,
            );
            // 确保非睡眠状态，否则下落不生效
            Matter.Sleeping.set(body, false);
            // 给一个初始向下速度，确保不被 enableSleeping 冻结
            Matter.Body.setVelocity(body, { x: 0, y: 2 });
            console.log(`[PotRenderer] Created pot physics body at (${pot.x}, ${bodyCenterY}), falling...`);
        } else {
            // 已存在的花盆直接标记为已落地
            isSettled = true;
        }

        const node: PotNode = {
            potId: pot.id,
            container,
            graphic: text,
            highlight,
            body,
            isSettled,
            lowVelFrames: 0,
        };
        this.nodes.set(pot.id, node);
        console.log(`[PotRenderer] Created pot at (${pot.x}, ${pot.y}), withPhysics=${withPhysics}, layer children: ${this.layer.children.length}`);
        return node;
    }

    private drawHighlight(g: PIXI.Graphics): void {
        g.clear();
        g.roundRect(-30, -30, 60, 55, 8);
        g.stroke({ color: 0xffd700, width: 2, alpha: 0.8 });
    }

    private destroyNode(node: PotNode): void {
        // 移除物理刚体
        if (node.body && this.physicsSystem) {
            this.physicsSystem.removeBody(node.body);
            node.body = null;
        }
        this.layer.removeChild(node.container);
        node.graphic.destroy();
        node.highlight.destroy();
        node.container.destroy();
    }

    private updateNodeAppearance(_plantId: string): void {
        // MVP 不做花盆外观变化（植物由 PlantRenderer 渲染）
    }

    // ─── 外部接口 ────────────────────────────────────────────────

    /** 在指定屏幕坐标添加花盆（新放置的花盆会通过物理下落到地面） */
    async addPotAt(x: number, y: number, style: Pot['style'] = 'clay'): Promise<Pot> {
        const pot = await this.gardenManager.addPot(x, y, style);
        this.createNode(pot, true); // true = 创建物理刚体，下落到地面
        return pot;
    }

    /** 删除花盆（连带植物） */
    async removePot(potId: string): Promise<void> {
        await this.gardenManager.removePot(potId);
        const node = this.nodes.get(potId);
        if (node) {
            this.destroyNode(node);
            this.nodes.delete(potId);
        }
    }

    /** 获取所有花盆 */
    getPots(): Pot[] {
        return this.gardenManager.getSnapshot().pots;
    }

    /** 获取指定花盆 */
    getPot(potId: string): Pot | undefined {
        return this.gardenManager.getSnapshot().pots.find(p => p.id === potId);
    }

    /** 查找坐标附近的花盆（半径 50px 内） */
    getPotAt(x: number, y: number): Pot | null {
        const pots = this.gardenManager.getSnapshot().pots;
        let nearest: Pot | null = null;
        let minDist = 50; // 点击容差半径
        for (const pot of pots) {
            const node = this.nodes.get(pot.id);
            if (!node) continue;
            // 用实际渲染位置（而非数据库坐标），确保拖动/下落后仍能命中
            const dx = node.container.x - x;
            const dy = node.container.y - y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                nearest = pot;
            }
        }
        return nearest;
    }

    /** 高亮指定花盆（供 GardenToolbar 在点击命中时调用） */
    highlightPot(potId: string): void {
        const node = this.nodes.get(potId);
        if (node) {
            node.highlight.visible = true;
            this.drawHighlight(node.highlight);
        }
    }

    /** 清除所有花盆高亮 */
    clearHighlight(): void {
        for (const [, node] of this.nodes) {
            node.highlight.visible = false;
        }
    }

    // ─── 每帧更新 ────────────────────────────────────────────────

    update(): void {
        if (!this.physicsSystem) return;
        const groundY = this.physicsSystem.getGroundTopScreenY();
        const pots = this.gardenManager.getSnapshot().pots;
        for (const [, node] of this.nodes) {
            if (!node.body || node.isSettled) continue;
            // 同步物理位置 → 渲染位置
            // 刚体底部 = 花盆中心，所以花盆中心 Y = 刚体中心 Y + H/2
            const screenPos = this.physicsSystem.physicsToScreen(
                node.body.position.x,
                node.body.position.y,
            );
            node.container.x = screenPos.x;
            node.container.y = screenPos.y + POT_PHYSICS_HEIGHT / 2;
            // 同步 pot 内存坐标（让 PlantRenderer 跟随下落）
            const pot = pots.find(p => p.id === node.potId);
            if (pot) {
                pot.x = node.container.x;
                pot.y = node.container.y;
            }
            // 检测落地：花盆中心 Y 到达地面顶面
            if (node.container.y >= groundY - 2) {
                node.lowVelFrames++;
                if (node.lowVelFrames >= SETTLE_FRAMES) {
                    this.settlePot(node);
                }
            } else {
                node.lowVelFrames = 0;
            }
        }
    }

    /** 花盆落地静止：转静态刚体，更新数据库坐标 */
    private async settlePot(node: PotNode): Promise<void> {
        if (!node.body || !this.physicsSystem) return;
        // 最终屏幕坐标
        const screenPos = this.physicsSystem.physicsToScreen(
            node.body.position.x,
            node.body.position.y,
        );
        // 花盆中心 = 地面顶面（花盆下半部分埋在土里）
        const groundY = this.physicsSystem.getGroundTopScreenY();
        node.container.x = screenPos.x;
        node.container.y = groundY;
        // 检测与其他花盆的重叠，落地后也推开
        this.resolveOverlap(node);
        // 转为静态刚体（停止物理模拟）
        this.physicsSystem.setBodyStatic(node.body);
        node.isSettled = true;
        node.body = null; // 已转静态，不再每帧同步
        // 更新数据库中的花盆坐标
        const pot = this.gardenManager.getSnapshot().pots.find(p => p.id === node.potId);
        if (pot) {
            pot.x = node.container.x;
            pot.y = groundY;
            await this.gardenManager.updatePot(pot);
        }
        console.log(`[PotRenderer] Pot settled at (${node.container.x}, ${groundY}), groundY=${groundY}`);
    }

    // ─── 拖动交互 ────────────────────────────────────────────────

    /** mousedown：检测是否点中花盆，开始拖动 */
    private onDragStart = (e: MouseEvent): void => {
        if (e.button !== 0) return; // 只处理左键
        const pot = this.getPotAt(e.clientX, e.clientY);
        if (!pot) return;
        const node = this.nodes.get(pot.id);
        if (!node) return;

        this.dragNode = node;
        this.dragOffsetX = e.clientX - node.container.x;
        this.dragOffsetY = e.clientY - node.container.y;
        this.dragMoved = false;

        // 移除物理刚体（拖动期间不使用物理）
        if (node.body && this.physicsSystem) {
            this.physicsSystem.removeBody(node.body);
            node.body = null;
        }
        node.isSettled = false;
        node.lowVelFrames = 0;
    };

    /** mousemove：拖动花盆 + 实时防重叠 + hover 光标 */
    private onDragMove = (e: MouseEvent): void => {
        if (this.dragNode) {
            // ── 拖动中 ──
            const newX = e.clientX - this.dragOffsetX;
            const newY = e.clientY - this.dragOffsetY;

            // 检测是否移动了足够距离（区分点击和拖动）
            const dx = newX - this.dragNode.container.x;
            const dy = newY - this.dragNode.container.y;
            if (!this.dragMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                this.dragMoved = true;
            }
            if (!this.dragMoved) return;

            // 更新位置
            this.dragNode.container.x = newX;
            this.dragNode.container.y = newY;
            // 实时检测重叠并推开
            this.resolveOverlap(this.dragNode);
            // resolveOverlap 可能修改了 container.x，同步最终位置到 pot 内存坐标（让 PlantRenderer 跟随）
            const pot = this.gardenManager.getSnapshot().pots.find(p => p.id === this.dragNode!.potId);
            if (pot) {
                pot.x = this.dragNode.container.x;
                pot.y = this.dragNode.container.y;
            }
            // 拖动光标
            document.body.style.cursor = 'grabbing';
        } else {
            // ── 非拖动，检测 hover ──
            const pot = this.getPotAt(e.clientX, e.clientY);
            document.body.style.cursor = pot ? 'grab' : '';
        }
    };

    /** mouseup：结束拖动，重新创建物理刚体下落 */
    private onDragEnd = (): void => {
        if (!this.dragNode) return;
        if (this.dragMoved) {
            const node = this.dragNode;
            const x = node.container.x;
            const y = node.container.y;
            // 重新创建物理刚体，让花盆下落到地面
            if (this.physicsSystem) {
                const bodyCenterY = y - POT_PHYSICS_HEIGHT / 2;
                node.body = this.physicsSystem.createPotBody(x, bodyCenterY, POT_PHYSICS_WIDTH, POT_PHYSICS_HEIGHT);
                Matter.Sleeping.set(node.body, false);
                Matter.Body.setVelocity(node.body, { x: 0, y: 2 });
            }
            // 更新数据库坐标
            const pot = this.gardenManager.getSnapshot().pots.find(p => p.id === node.potId);
            if (pot) {
                pot.x = x;
                pot.y = y;
                this.gardenManager.updatePot(pot).catch(() => { });
            }
            // 标记：拖动刚结束，忽略紧随的 click 事件
            this.suppressClick = true;
            setTimeout(() => { this.suppressClick = false; }, 300);
        }
        this.dragNode = null;
        this.dragMoved = false;
        // 恢复光标
        document.body.style.cursor = '';
    };

    /**
     * 检测当前花盆与其他花盆的重叠，推开当前花盆
     * 只在 X 方向推开（不改变 Y），保持花盆在当前高度
     */
    private resolveOverlap(node: PotNode): void {
        const minDist = POT_PHYSICS_WIDTH; // 最小间距 = 花盆宽度
        for (const [, other] of this.nodes) {
            if (other === node) continue;
            const dx = node.container.x - other.container.x;
            const dy = node.container.y - other.container.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist && dist > 0.01) {
                // 沿 X 方向推开当前花盆
                const push = minDist - dist;
                const ratio = push / dist;
                node.container.x += dx * ratio;
            }
        }
    }

    /**
     * 查找不与已落地花盆重叠的 X 位置
     * 如果指定 x 与已有花盆过近，向右推移直到不重叠
     */
    private findNonOverlappingX(x: number): number {
        const minDist = POT_PHYSICS_WIDTH;
        let newX = x;
        for (const [, other] of this.nodes) {
            if (!other.isSettled) continue;
            const dx = newX - other.container.x;
            const dist = Math.abs(dx);
            if (dist < minDist) {
                // 向右推移到最小间距
                const sign = dx >= 0 ? 1 : -1;
                newX = other.container.x + sign * minDist;
            }
        }
        return newX;
    }
}

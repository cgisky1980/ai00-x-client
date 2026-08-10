// ========================================================================
// 访客渲染器（VisitorAvatar）
// ========================================================================
// 职责：
// - 渲染单个访客 NPC（Spine 头像，复用 createSpineAvatar 加载逻辑）
// - 移动逻辑（从屏幕边缘走到目标点，停留，再离开）
// - 头顶名字标签（NameTag 组件，与主角统一）
// - 头顶活动气泡（SpeechBubbleSystem，与主角统一）
// - 点击访客触发交互回调
// ========================================================================

import * as PIXI from 'pixi.js';
import type { Spine } from '@esotericsoftware/spine-pixi-v8';
import { createSpineAvatar, AVATAR_SCALE } from '../avatar/UserAvatar';
import { PET_RESOURCE_BASE } from '../api/gardenApi';
import { NameTag, NAME_TAG_Y } from '../avatar/NameTag';
import { SpeechBubbleSystem } from '../avatar/SpeechBubbleSystem';
import type { AvatarSelection } from '../avatar/avatar-config';
import type { ActiveVisitor, AvatarActivity, VisitorPhase } from './types';

/** Spine root 不在脚部，需要 footOffset 校正（与 UserAvatar 一致） */
const FOOT_OFFSET = 59 * AVATAR_SCALE;

/** 访客生命周期阶段 → 气泡 emoji（arriving/leaving 显示 👋） */
const PHASE_BUBBLE: Partial<Record<VisitorPhase, string>> = {
    arriving: '👋',
    leaving: '👋',
};

export class VisitorAvatar {
    private app: PIXI.Application;
    private visitor: ActiveVisitor;
    private container: PIXI.Container;
    private spine: Spine | null = null;
    private isDestroyed = false;

    /** 头顶名字标签（白色发光 + 国旗，与主角共用 NameTag 组件） */
    private nameTag: NameTag;
    /** 头顶活动气泡（与主角共用 SpeechBubbleSystem） */
    private bubble: SpeechBubbleSystem;

    /** 持久化 slot 颜色（每帧重新应用，防止被动画覆盖） */
    private persistentSlotColors: Map<string, string> = new Map();

    /** 点击访客回调 */
    onClick?: (visitor: ActiveVisitor) => void;

    /** 移动目标（屏幕坐标），null 表示不移动 */
    private moveTarget: { x: number; y: number } | null = null;
    /** 移动速度范围（像素/秒）—— 每次 moveTo 时随机，让速度有变化 */
    private static readonly MOVE_SPEED_MIN = 90;
    private static readonly MOVE_SPEED_MAX = 160;
    /** 当前移动速度（moveTo 时随机赋值） */
    private moveSpeed = 125;

    constructor(app: PIXI.Application, visitor: ActiveVisitor, parentLayer?: PIXI.Container) {
        this.app = app;
        this.visitor = { ...visitor };
        this.container = new PIXI.Container();
        this.container.x = visitor.x;
        this.container.y = visitor.y;
        this.container.zIndex = 12; // 访客层：角色(10) 之上，花草(15) 之下
        this.container.interactive = true;
        this.container.cursor = 'pointer';
        this.container.eventMode = 'static';
        this.container.sortableChildren = true;

        // 名字标签（白色发光 + 国旗 + 性别，与主角统一高度 NAME_TAG_Y）
        this.nameTag = new NameTag({
            text: this.visitor.username,
            fillColor: 0x333333,
            strokeColor: 0xffffff,
            fontSize: 13,
            showFlag: true,
            country: this.visitor.country,
            gender: this.visitor.gender,
        });
        this.nameTag.setAnchor(0, FOOT_OFFSET + NAME_TAG_Y);
        this.container.addChild(this.nameTag.view);

        // 活动气泡（复用主角 SpeechBubbleSystem）
        this.bubble = new SpeechBubbleSystem(this.container);

        // 异步加载 Spine 头像
        void this.loadSpine();

        this.container.on('pointerdown', (e: PIXI.FederatedPointerEvent) => {
            e.stopPropagation();
            this.onClick?.(this.visitor);
        });

        (parentLayer ?? this.app.stage).addChild(this.container);
        this.app.ticker.add(this.tick);
        this.app.ticker.add(this.tickColorApply);
    }

    // ─── Spine 加载 ──────────────────────────────────────────────

    private async loadSpine(): Promise<void> {
        if (this.isDestroyed) return;
        try {
            const baseUrl = PET_RESOURCE_BASE;
            // NPC.avatarData 是 AvatarSelection 格式；为空时用 config defaults
            const hasParts = this.visitor.avatarData && Object.keys(this.visitor.avatarData.parts ?? {}).length > 0;
            const hasColors = this.visitor.avatarData && Object.keys(this.visitor.avatarData.colors ?? {}).length > 0;
            const selection: AvatarSelection | undefined =
                this.visitor.avatarData && (hasParts || hasColors)
                    ? this.visitor.avatarData
                    : undefined;

            const spine = await createSpineAvatar(baseUrl, selection);
            if (this.isDestroyed) {
                spine.destroy();
                return;
            }
            this.spine = spine;
            // Spine root 不在脚部，需要 footOffset 校正让脚对齐 container 原点
            spine.y = FOOT_OFFSET;
            this.container.addChild(spine);

            // 记录持久化颜色
            if (selection?.colors) {
                for (const [slotName, colorHex] of Object.entries(selection.colors)) {
                    this.persistentSlotColors.set(slotName, colorHex);
                }
            }
        } catch (e) {
            console.warn('[VisitorAvatar] loadSpine failed, fallback to emoji:', e);
            this.buildEmojiFallback();
        }
    }

    /** Spine 加载失败时的 emoji 降级 */
    private buildEmojiFallback(): void {
        if (this.isDestroyed) return;
        const emoji = new PIXI.Text({
            text: '🧑',
            style: {
                fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                fontSize: 48,
                fill: 0xffffff,
            },
        });
        emoji.anchor.set(0.5, 0.5);
        emoji.y = -30;
        this.container.addChild(emoji);
    }

    // ─── 状态更新 ────────────────────────────────────────────────

    /** 更新访客活动状态（与主角统一使用 AvatarActivity，驱动气泡显示） */
    setActivity(activity: AvatarActivity): void {
        if (this.visitor.activity === activity) return;
        this.visitor.activity = activity;
        // visiting 阶段由 activity 驱动气泡；arriving/leaving 由 phase 驱动
        if (this.visitor.phase === 'visiting') {
            this.bubble.showForActivity(activity);
        }
    }

    /** 更新访客生命周期阶段（arriving/leaving 时显示 👋 气泡） */
    setPhase(phase: VisitorPhase): void {
        if (this.visitor.phase === phase) return;
        this.visitor.phase = phase;
        const emoji = PHASE_BUBBLE[phase];
        if (emoji) {
            this.bubble.show(emoji, phase === 'arriving' ? 3000 : undefined);
        } else if (phase === 'visiting') {
            // 进入 visiting 后由当前 activity 驱动气泡
            this.bubble.showForActivity(this.visitor.activity);
        }
    }

    /** 设置移动目标（每次随机一个速度，让访客步速有变化） */
    moveTo(x: number, y: number): void {
        this.moveTarget = { x, y };
        this.moveSpeed =
            VisitorAvatar.MOVE_SPEED_MIN +
            Math.random() * (VisitorAvatar.MOVE_SPEED_MAX - VisitorAvatar.MOVE_SPEED_MIN);
    }

    /** 获取当前访客数据 */
    getVisitor(): ActiveVisitor {
        return { ...this.visitor };
    }

    /** 更新位置（同步到 visitor 数据） */
    setPosition(x: number, y: number): void {
        this.visitor.x = x;
        this.visitor.y = y;
        this.container.x = x;
        this.container.y = y;
    }

    // ─── 每帧更新 ────────────────────────────────────────────────

    private tick = (): void => {
        if (this.isDestroyed) return;
        // 同步气泡锚点到 spine root（与主角统一坐标系）
        this.bubble.setAnchor(0, FOOT_OFFSET);

        if (!this.moveTarget) return;
        const dt = this.app.ticker.deltaMS / 1000;
        const dx = this.moveTarget.x - this.visitor.x;
        const dy = this.moveTarget.y - this.visitor.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 2) {
            this.moveTarget = null;
            return;
        }
        const step = Math.min(dist, this.moveSpeed * dt);
        const nx = this.visitor.x + (dx / dist) * step;
        const ny = this.visitor.y + (dy / dist) * step;
        this.setPosition(nx, ny);
        // 朝向：移动方向
        if (this.spine && Math.abs(dx) > 1) {
            this.spine.scale.x = dx > 0 ? AVATAR_SCALE : -AVATAR_SCALE;
        }
    };

    /** 每帧重新应用持久化 slot 颜色（防止被动画覆盖）
     *  spine-pixi-v8 4.2.95: 颜色存储在 slot.color（直接属性），渲染时 Spine.js 读 slot.color
     *  注意:4.3.x 才用 slot.pose.color,4.2.x 是 slot.color
     */
    private tickColorApply = (): void => {
        if (!this.spine || this.persistentSlotColors.size === 0) return;
        for (const [slotName, colorHex] of this.persistentSlotColors) {
            const slot = this.spine.skeleton.findSlot(slotName);
            if (slot) {
                const slotAny = slot as any;
                // 优先 slot.color(4.2.x),回退 slot.pose.color(4.3.x)
                const colorObj = slotAny.color ?? slotAny.pose?.color;
                if (colorObj) {
                    const { r, g, b } = hexToRgbLocal(colorHex);
                    colorObj.set(r, g, b, colorObj.a);
                }
            }
        }
    };

    // ─── 销毁 ────────────────────────────────────────────────────

    destroy(): void {
        if (this.isDestroyed) return;
        this.isDestroyed = true;
        this.app.ticker.remove(this.tick);
        this.app.ticker.remove(this.tickColorApply);
        this.container.removeAllListeners();
        this.bubble.destroy();
        this.nameTag.destroy();
        if (this.spine) {
            this.spine.destroy();
            this.spine = null;
        }
        this.container.destroy({ children: true });
    }
}

/** Hex 颜色转 RGB (0-1) */
function hexToRgbLocal(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    return { r, g, b };
}

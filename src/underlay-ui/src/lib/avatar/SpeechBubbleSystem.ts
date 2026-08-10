// ========================================================================
// 言语气泡系统（SpeechBubbleSystem）
// ========================================================================
// 在化身/访客头顶显示 emoji 气泡，标明当前活动状态
// MVP 用 PIXI.Text + Graphics 渲染（emoji 友好），后续可换成贴图
// ========================================================================

import * as PIXI from 'pixi.js';
import type { AvatarActivity } from '../world/types';

/** 活动 → emoji 映射（仅需要气泡的活动列入；移动类不显示） */
const ACTIVITY_EMOJI: Partial<Record<AvatarActivity, string>> = {
    resting: '😴',
    reading: '📖',
    watering: '💧',
    harvesting: '🌾',
    planting: '🌱',
    photographing: '📷',
    greeting: '👋',
    playing: '🎈',
    chatting: '💬',
    returning: '🏠',
    // idle/walking/jumping/rolling/flying/visiting 不显示气泡
};

/** 气泡持续时间（ms），undefined 表示持续显示直到 hide() */
const ACTIVITY_DURATION: Partial<Record<AvatarActivity, number>> = {
    resting: undefined,       // 休息一直显示
    reading: undefined,       // 阅读一直显示
    watering: 3000,           // 浇花 3s
    harvesting: 3000,
    planting: 3000,
    photographing: 3000,
    greeting: 2000,           // 迎接 2s
    playing: undefined,
    chatting: 3000,
    returning: 3000,
};

export class SpeechBubbleSystem {
    private parent: PIXI.Container;
    private bubble: PIXI.Container;
    private bg: PIXI.Graphics;
    private text: PIXI.Text;
    private visible = false;
    private hideTimer: ReturnType<typeof setTimeout> | null = null;

    /** 气泡锚点（屏幕坐标，通常是化身头顶） */
    private anchorX = 0;
    private anchorY = 0;

    /** 气泡在锚点上方的偏移（屏幕像素，相对 spine root；大于 NAME_TAG_Y 绝对值以位于名字上方） */
    private readonly offsetY = 200;

    constructor(parent: PIXI.Container) {
        this.parent = parent;
        this.bubble = new PIXI.Container();
        this.bubble.zIndex = 100;
        this.bubble.visible = false;

        this.bg = new PIXI.Graphics();
        this.bubble.addChild(this.bg);

        this.text = new PIXI.Text({
            text: '',
            style: {
                fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                fontSize: 28,
                fill: 0xffffff,
                align: 'center',
            },
        });
        this.text.anchor.set(0.5, 0.5);
        this.bubble.addChild(this.text);

        this.parent.addChild(this.bubble);
    }

    /** 显示气泡（如果传入 activity，自动选 emoji 与持续时间） */
    showForActivity(activity: AvatarActivity): void {
        const emoji = ACTIVITY_EMOJI[activity];
        if (!emoji) {
            this.hide();
            return;
        }
        const duration = ACTIVITY_DURATION[activity];
        this.show(emoji, duration);
    }

    /** 直接显示指定文本/emoji */
    show(text: string, durationMs?: number): void {
        this.text.text = text;
        this.redrawBackground();
        this.bubble.visible = true;
        this.visible = true;

        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        if (durationMs !== undefined) {
            this.hideTimer = setTimeout(() => this.hide(), durationMs);
        }
    }

    hide(): void {
        this.bubble.visible = false;
        this.visible = false;
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    /** 设置气泡锚点（化身头顶屏幕坐标） */
    setAnchor(x: number, y: number): void {
        this.anchorX = x;
        this.anchorY = y;
        this.bubble.x = x;
        this.bubble.y = y - this.offsetY;
    }

    /** 每帧更新（如有动画需求可扩展） */
    update(): void {
        if (!this.visible) return;
        this.bubble.x = this.anchorX;
        this.bubble.y = this.anchorY - this.offsetY;
    }

    private redrawBackground(): void {
        this.bg.clear();
        const padding = 12;
        const w = Math.max(this.text.width + padding * 2, 44);
        const h = Math.max(this.text.height + padding * 2, 44);
        // 圆角矩形背景
        this.bg.roundRect(-w / 2, -h / 2, w, h, 14);
        this.bg.fill({ color: 0xffffff, alpha: 0.92 });
        this.bg.stroke({ color: 0x000000, alpha: 0.1, width: 1 });
        // 下方小三角（指向化身）
        this.bg.moveTo(-6, h / 2 - 1);
        this.bg.lineTo(6, h / 2 - 1);
        this.bg.lineTo(0, h / 2 + 8);
        this.bg.fill({ color: 0xffffff, alpha: 0.92 });
    }

    destroy(): void {
        this.hide();
        this.parent.removeChild(this.bubble);
        this.bg.destroy();
        this.text.destroy();
        this.bubble.destroy();
    }
}

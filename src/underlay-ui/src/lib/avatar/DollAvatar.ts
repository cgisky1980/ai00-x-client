import * as PIXI from 'pixi.js';
import { BoneDoll } from '@ai00-x/bone-doll';
import { ExpressionSystem, type ExpressionFrame } from './ExpressionSystem';
import type { AvatarActivity, AvatarMood } from '../world/types';

/**
 * 骨骼纸娃娃化身适配器：把 @ai00-x/bone-doll 运行时包装成行为控制器能用的
 * "Spine 形"目标（AvatarAnimTarget 结构类型），视图通过 `view` 挂进场景。
 *
 * 语义映射（Px2d 风 chibi · 骨骼路线 v2.0）：
 * - scale 域：外部读写 AVATAR_SCALE（0.6 域），内部换算为精灵像素缩放；
 *   scale.x 的**符号解释为朝向**（bone-doll 的 left = right 画布级镜像）。
 * - state.setAnimation：Spine 动画名（Idle/Walk/Attack...）→ 骨骼动画
 *   （idle/walk/attack/work）；attack 为一次性动作（播完自动回 idle）。
 * - 驱动：由 UserAvatar 的 ticker 调 update(deltaMS)（tick+render+纹理上传）。
 */

/** 画布内部放大倍数（64 帧 → 128px 画布，2x 保细节） */
const DOLL_INTERNAL_SCALE = 2;
/** AVATAR_SCALE 域 → 精灵缩放系数：0.6 × 1.5 × 128px 画布 ≈ 115px 屏幕高 */
const DOLL_AVATAR_SCALE_K = 1.5;
/** chibi 素体鞋底线在 64px 帧底部上方的内缩像素（脚踩实地面的锚点校正） */
const GROUND_INSET_FRAME_PX = 6;

/** 表情帧在玩偶画布（128×128）上的绘制尺寸与位置。
 *  素材每帧 144×90（3 倍密度），按脸部件宽度对齐：
 *  脸部件 64×64 逻辑（画布 2x=128），head 骨骼在逻辑 (32,36) → 画布 (64,72)；
 *  表情画 64×40（保持 144:90 比例），中心对齐 head → x=32, y=52。
 *  这四个值可按实际观感微调。 */
const EXPR_DRAW_W = 64;
const EXPR_DRAW_H = 40;
const EXPR_DRAW_X = (DOLL_INTERNAL_SCALE * 64 - EXPR_DRAW_W) / 2;
const EXPR_DRAW_Y = DOLL_INTERNAL_SCALE * 36 - EXPR_DRAW_H / 2;

/** 化身动画目标的结构类型（Spine 与 DollAvatar 都满足；见 AvatarBehaviorController） */
export interface AvatarAnimTarget {
    x: number;
    y: number;
    readonly parent: PIXI.Container | null;
    scale: { x: number; set(x: number, y?: number): void };
    state: { setAnimation(track: number, name: string, loop: boolean): void };
    skeleton: { data: { animations: { name: string }[] }; findSlot(_name: string): unknown | null };
    /** 表情系统（仅 DollAvatar 路线实现；Spine 路线无） */
    reactExpression?(activity: AvatarActivity, mood: AvatarMood): boolean;
    idleExpressionTick?(): boolean;
    pokeExpression?(): boolean;
}

export class DollAvatar implements AvatarAnimTarget {
    /** 场景视图（UserAvatar.container 的子节点；物理同步 x/y 写这里） */
    readonly view = new PIXI.Container();
    private readonly sprite: PIXI.Sprite;
    private readonly texture: PIXI.Texture;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly doll: BoneDoll;
    /** 表情系统（素材来自岛仔 Daozai，MIT） */
    private readonly expressions: ExpressionSystem;
    /** AVATAR_SCALE 域的原始 scale.x（含符号，行为控制器按 0.6 域读写） */
    private rawScaleX = 0.6;
    readonly scale: AvatarAnimTarget['scale'];

    private constructor(doll: BoneDoll) {
        this.doll = doll;
        this.canvas = document.createElement('canvas');
        doll.attach(this.canvas);
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
        this.expressions = new ExpressionSystem(new URL('pet/doll2/', document.baseURI).href);
        this.texture = PIXI.Texture.from(this.canvas);
        this.sprite = new PIXI.Sprite(this.texture);
        // 锚点 = 帧底中（脚底），物理同步把 view.y 放在地面即可
        this.sprite.anchor.set(0.5, 1);
        this.view.addChild(this.sprite);
        this.applyScale();

        // scale 适配器：getter/setter 解释 AVATAR_SCALE 域（符号 → 朝向镜像，幅值 → 像素缩放）
        const av = this;
        const scale = {
            set(x: number, _y?: number): void {
                av.writeScaleX(x);
            },
        };
        Object.defineProperty(scale, 'x', {
            enumerable: true,
            get: (): number => av.rawScaleX,
            set: (v: number): void => av.writeScaleX(v),
        });
        this.scale = scale as AvatarAnimTarget['scale'];
    }

    static async create(baseUrl: string): Promise<DollAvatar> {
        const doll = await BoneDoll.load(baseUrl, { scale: DOLL_INTERNAL_SCALE });
        return new DollAvatar(doll);
    }

    // ---------------- AvatarAnimTarget：位置（代理到 view） ----------------

    get x(): number { return this.view.x; }
    set x(v: number) { this.view.x = v; }
    get y(): number { return this.view.y; }
    set y(v: number) { this.view.y = v; }

    get parent(): PIXI.Container {
        return this.view.parent as PIXI.Container;
    }

    // ---------------- scale 域实现 ----------------

    private writeScaleX(v: number): void {
        this.rawScaleX = v;
        const dir = v < 0 ? 'left' : 'right';
        if (this.doll.currentDirection !== dir) {
            this.doll.setDirection(dir);
        }
        this.applyScale();
    }

    private applyScale(): void {
        this.sprite.scale.set(Math.abs(this.rawScaleX) * DOLL_AVATAR_SCALE_K);
    }

    /** 地面线内缩的屏幕像素（UserAvatar 物理锚点校正用） */
    get groundInsetPx(): number {
        return GROUND_INSET_FRAME_PX * DOLL_AVATAR_SCALE_K * Math.abs(this.rawScaleX);
    }

    // ---------------- AvatarAnimTarget：动画（Spine 名 → 骨骼动画） ----------------

    readonly state = {
        setAnimation: (_track: number, name: string, _loop: boolean): void => {
            this.playMapped(name);
        },
    };

    readonly skeleton = {
        data: { animations: [{ name: 'idle' }, { name: 'walk' }, { name: 'attack' }, { name: 'work' }] },
        findSlot: (_name: string): null => null,
    };

    private playMapped(name: string): void {
        const n = name.toLowerCase();
        const target = n.includes('walk') ? 'walk'
            : n.includes('slash') || n.includes('attack') ? 'attack'
            : n.includes('work') ? 'work'
            : n.includes('idle') ? 'idle'
            : null;
        // 未识别的动画名保持当前播放不变；attack 为一次性（bone-doll 播完自动回 idle）
        if (target !== null && this.doll.hasAnim(target)) {
            this.doll.play(target);
        }
    }

    // ---------------- 表情系统接口 ----------------

    /** 行为变化触发表情；返回是否触发 */
    reactExpression(activity: AvatarActivity, mood: AvatarMood): boolean {
        return this.expressions.react(activity, mood);
    }

    /** 日常待机低频触发（由行为控制器在 idle tick 里调） */
    idleExpressionTick(): boolean {
        return this.expressions.idleTick();
    }

    /** 悬停/被关注触发 */
    pokeExpression(): boolean {
        return this.expressions.poke();
    }

    setExpressionHidden(hidden: boolean): void {
        this.expressions.setHidden(hidden);
    }

    // ---------------- 每帧驱动 ----------------

    update(deltaMs: number): void {
        this.doll.tick(deltaMs);
        this.doll.render();
        const frame = this.expressions.update(deltaMs);
        if (frame) this.drawExpression(frame);
        this.texture.source.update();
    }

    /** 把表情帧合成到玩偶画布（bone-doll render 之后，同一 canvas 共享镜像/缩放） */
    private drawExpression(frame: ExpressionFrame): void {
        const ctx = this.ctx;
        const facingLeft = this.doll.currentDirection === 'left';
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (facingLeft) {
            // 与 bone-doll 的 left 画布级镜像保持一致
            ctx.translate(this.canvas.width, 0);
            ctx.scale(-1, 1);
        }
        // 浅色主题下素材眼睛本就是深色（#28150d），无需改色；
        // 仅略微压低高光以适配浅底（岛仔的深度像素映射在 canvas 合成下用不上）。
        ctx.globalAlpha = 0.95;
        ctx.drawImage(
            frame.image,
            frame.sx, frame.sy, frame.sw, frame.sh,
            EXPR_DRAW_X, EXPR_DRAW_Y, EXPR_DRAW_W, EXPR_DRAW_H,
        );
        ctx.restore();
    }

    destroy(): void {
        this.expressions.stop();
        this.doll.dispose();
        this.texture.destroy(true);
        this.sprite.destroy();
        this.view.destroy({ children: true });
    }
}

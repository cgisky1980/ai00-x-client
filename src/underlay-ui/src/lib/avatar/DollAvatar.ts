import * as PIXI from 'pixi.js';
import { BoneDoll } from '@ai00-x/bone-doll';

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

/** 化身动画目标的结构类型（Spine 与 DollAvatar 都满足；见 AvatarBehaviorController） */
export interface AvatarAnimTarget {
    x: number;
    y: number;
    readonly parent: PIXI.Container | null;
    scale: { x: number; set(x: number, y?: number): void };
    state: { setAnimation(track: number, name: string, loop: boolean): void };
    skeleton: { data: { animations: { name: string }[] }; findSlot(_name: string): unknown | null };
}

export class DollAvatar implements AvatarAnimTarget {
    /** 场景视图（UserAvatar.container 的子节点；物理同步 x/y 写这里） */
    readonly view = new PIXI.Container();
    private readonly sprite: PIXI.Sprite;
    private readonly texture: PIXI.Texture;
    private readonly canvas: HTMLCanvasElement;
    private readonly doll: BoneDoll;
    /** AVATAR_SCALE 域的原始 scale.x（含符号，行为控制器按 0.6 域读写） */
    private rawScaleX = 0.6;
    readonly scale: AvatarAnimTarget['scale'];

    private constructor(doll: BoneDoll) {
        this.doll = doll;
        this.canvas = document.createElement('canvas');
        doll.attach(this.canvas);
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

    // ---------------- 每帧驱动 ----------------

    update(deltaMs: number): void {
        this.doll.tick(deltaMs);
        this.doll.render();
        this.texture.source.update();
    }

    destroy(): void {
        this.doll.dispose();
        this.texture.destroy(true);
        this.sprite.destroy();
        this.view.destroy({ children: true });
    }
}

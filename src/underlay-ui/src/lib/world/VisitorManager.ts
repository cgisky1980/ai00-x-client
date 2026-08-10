// ========================================================================
// 访客管理器（VisitorManager）— 多访客并发版
// ========================================================================
// 职责：
// - 定时轮询 gardenApi.requestVisit() 请求访客，保持 2-3 个访客在场
// - 管理多访客生命周期：arriving → visiting(跟随式协作) → leaving
// - 跟随式 AI：读取主人活动，按决策表+personality 权重选择协作行为
// - 订阅主人活动变化事件，主人换活动时所有访客立即重新决策
// - 访客带来种子时加入 collection
// - 点击访客 → chatting（S7）
// ========================================================================

import * as PIXI from 'pixi.js';
import { getGardenApi } from '../api/gardenApi';
import type { Neighbor } from '../api/types';
import type { GardenManager } from './GardenManager';
import type { ActiveVisitor, AvatarActivity } from './types';
import { VisitorAvatar } from './VisitorAvatar';
import { generateNpc, randomSeedType, NPC_ID_MIN, NPC_ID_MAX } from './npcGenerator';

/** 最大并发访客数 */
const MAX_CONCURRENT_VISITORS = 3;
/** 低于此数时优先补充访客 */
const MIN_CONCURRENT_VISITORS = 2;

/** 轮询间隔（ms）—— 首次 10s，之后每 30s 检查是否需要补充 */
const INITIAL_POLL_DELAY = 10_000;
const POLL_INTERVAL = 30_000;

/** 访客停留时长范围（ms）—— 3-10 分钟 */
const STAY_MIN = 3 * 60_000;
const STAY_MAX = 10 * 60_000;

/** 各阶段时长（ms） */
const ARRIVING_DURATION = 4_000;
const GREETING_DURATION = 3_000;
const FOLLOW_INTERVAL_MIN = 5_000;
const FOLLOW_INTERVAL_MAX = 10_000;
const CHAT_DURATION = 8_000;
const LEAVING_EXIT_DURATION = 3_000;

/** 决策选项 */
interface DecisionOption {
    activity: AvatarActivity;
    weight: number;
    /** true=走到主人旁边，false=走到随机点 */
    near: boolean;
    /** 走向花盆（优先级高于 near，设为此值时走到花盆旁边） */
    potX?: number;
}

/** 单个访客的运行时状态 */
interface VisitorState {
    avatar: VisitorAvatar;
    data: ActiveVisitor;
    personality: Neighbor['personality'] | null;
    behaviorTimer: ReturnType<typeof setTimeout> | null;
    leaveTimer: ReturnType<typeof setTimeout> | null;
}

export class VisitorManager {
    private app: PIXI.Application;
    private gardenManager: GardenManager;
    private layer: PIXI.Container;
    private isRunning = false;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    /** 多访客并发存储（按 instanceId 索引） */
    private visitors: Map<string, VisitorState> = new Map();
    /** 服务器不可用时降级为本地模拟访客 */
    private usingLocalFallback = false;
    /** 本地降级时可用的 NPC memberId 列表（排除已在场的，避免重复） */
    private availableLocalNpcIds: number[] = [];
    /** 获取地面 Y（屏幕坐标），让访客脚踩地面 */
    private getGroundY: () => number;
    /** GardenManager 事件取消订阅（S6：主人活动变化时重新决策） */
    private unsubscribeGarden: (() => void) | null = null;

    /** 访客到达回调 */
    onVisitorArrived?: (visitor: ActiveVisitor) => void;
    /** 访客离开回调 */
    onVisitorLeft?: (instanceId: string) => void;

    constructor(
        app: PIXI.Application,
        gardenManager: GardenManager,
        getGroundY: () => number = () => window.innerHeight - 100,
        parentLayer?: PIXI.Container,
    ) {
        this.app = app;
        this.gardenManager = gardenManager;
        this.getGroundY = getGroundY;
        this.layer = parentLayer ?? new PIXI.Container();
        this.layer.zIndex = 12;
        if (!parentLayer) {
            this.app.stage.addChild(this.layer);
        }
        // 初始化本地 NPC 可用 memberId 列表（1001-2000，共 1000 个确定性 NPC）
        this.availableLocalNpcIds = [];
        for (let id = NPC_ID_MIN; id <= NPC_ID_MAX; id++) {
            this.availableLocalNpcIds.push(id);
        }
    }

    // ─── 生命周期 ────────────────────────────────────────────────

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        // S6：订阅主人活动变化，主人换活动时所有访客立即重新决策
        this.unsubscribeGarden = this.gardenManager.on((event) => {
            if (event.type === 'avatar:activity-changed') {
                this.onHostActivityChanged(event.activity);
            }
        });
        // 首次延迟后请求访客
        this.schedulePoll(INITIAL_POLL_DELAY);
    }

    stop(): void {
        this.isRunning = false;
        this.unsubscribeGarden?.();
        this.unsubscribeGarden = null;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.removeAllVisitors();
    }

    private schedulePoll(delay: number): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(() => {
            void this.pollOnce();
        }, delay);
    }

    // ─── 轮询 ────────────────────────────────────────────────────

    private async pollOnce(): Promise<void> {
        if (!this.isRunning) return;

        // 访客数量已达上限，等下个周期再检查
        if (this.visitors.size >= MAX_CONCURRENT_VISITORS) {
            this.schedulePoll(POLL_INTERVAL);
            return;
        }

        // 本地降级模式：直接用预设 NPC 生成访客
        if (this.usingLocalFallback) {
            const npc = this.pickLocalNpc();
            if (npc) {
                const broughtSeed = randomSeedType();
                await this.handleVisitorArrived(npc, broughtSeed);
            }
            // 数量不足时缩短轮询间隔快速补充
            const nextDelay = this.visitors.size < MIN_CONCURRENT_VISITORS ? 5_000 : POLL_INTERVAL;
            this.schedulePoll(nextDelay);
            return;
        }

        try {
            const api = getGardenApi();
            const result = await api.requestVisit();
            if (result) {
                await this.handleVisitorArrived(result.visitor, result.broughtSeed);
            }
        } catch (e) {
            // 服务器未启动 / API 404 / token 失效等 → 降级为本地模拟
            console.warn('[VisitorManager] requestVisit failed, switch to local fallback:', e);
            this.usingLocalFallback = true;
            const npc = this.pickLocalNpc();
            if (npc) {
                const broughtSeed = randomSeedType();
                await this.handleVisitorArrived(npc, broughtSeed);
            }
        }
        // 数量不足时缩短轮询间隔快速补充
        const nextDelay = this.visitors.size < MIN_CONCURRENT_VISITORS ? 5_000 : POLL_INTERVAL;
        this.schedulePoll(nextDelay);
    }

    /** 从本地 NPC 池中选一个不在场的（避免重复）
     *  池子大小 1000（memberId 1001-2000），确定性生成 */
    private pickLocalNpc(): Neighbor | null {
        if (this.availableLocalNpcIds.length === 0) {
            // 所有 NPC 都在场，重置可用列表（允许重复）
            this.availableLocalNpcIds = [];
            for (let id = NPC_ID_MIN; id <= NPC_ID_MAX; id++) {
                this.availableLocalNpcIds.push(id);
            }
        }
        const idx = Math.floor(Math.random() * this.availableLocalNpcIds.length);
        const memberId = this.availableLocalNpcIds.splice(idx, 1)[0];
        return generateNpc(memberId);
    }

    // ─── 访客生命周期 ────────────────────────────────────────────

    private async handleVisitorArrived(npc: Neighbor, broughtSeed: string): Promise<void> {
        const now = Date.now();
        const stayDuration = STAY_MIN + Math.random() * (STAY_MAX - STAY_MIN);
        // 多访客从两侧入场，避免重叠
        const enterFromLeft = this.visitors.size % 2 === 0;
        const startX = enterFromLeft ? -80 : window.innerWidth + 80;
        const startY = this.getGroundY();
        const instanceId = `visitor_${now}_${npc.memberId}_${Math.floor(Math.random() * 1000)}`;

        const visitor: ActiveVisitor = {
            instanceId,
            memberId: npc.memberId,
            username: npc.username,
            country: npc.country,
            gender: npc.gender,
            avatarData: npc.avatarData,
            broughtSeed: broughtSeed as ActiveVisitor['broughtSeed'],
            arrivedAt: now,
            leaveAt: now + stayDuration,
            activity: 'walking',
            phase: 'arriving',
            x: startX,
            y: startY,
        };

        const avatar = new VisitorAvatar(this.app, visitor, this.layer);
        avatar.onClick = (v) => this.handleVisitorClick(v.instanceId);
        this.onVisitorArrived?.(visitor);

        const state: VisitorState = {
            avatar,
            data: visitor,
            personality: npc.personality ?? null,
            behaviorTimer: null,
            leaveTimer: null,
        };
        this.visitors.set(instanceId, state);

        // 带来种子 → 加入 collection
        if (broughtSeed) {
            await this.gardenManager.addCollectionItem(
                'seed',
                broughtSeed as any,
                'visitor',
                `${npc.username} 来访带来的种子`,
                1,
            );
        }

        // 阶段1：arriving → 走到屏幕内（多个访客错开 greetX 避免重叠）
        const greetX = this.calcGreetX();
        const greetY = this.getGroundY();
        avatar.moveTo(greetX, greetY);

        // 走到后进入 visiting
        state.behaviorTimer = setTimeout(() => {
            this.enterVisiting(instanceId);
        }, ARRIVING_DURATION);

        // 安排离开检查
        this.scheduleLeaveCheck(instanceId);
    }

    /** 计算访客的 greeting 位置（错开避免重叠） */
    private calcGreetX(): number {
        const count = this.visitors.size;
        // 在屏幕 20%-70% 范围内均匀错开
        const ratio = 0.2 + (count * 0.25) % 0.5;
        return window.innerWidth * ratio;
    }

    /** 进入 visiting 阶段：打招呼 → 跟随式协作循环 */
    private enterVisiting(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        state.avatar.setPhase('visiting');
        state.avatar.setActivity('greeting');

        // greeting 持续 3s 后进入跟随循环
        state.behaviorTimer = setTimeout(() => {
            this.enterFollowLoop(instanceId);
        }, GREETING_DURATION);
    }

    /** 跟随式协作循环：每 5-10s 根据主人活动决策 */
    private enterFollowLoop(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        this.makeFollowDecision(instanceId);
        this.scheduleNextFollowDecision(instanceId);
    }

    private scheduleNextFollowDecision(instanceId: string): void {
        if (!this.isRunning) return;
        const state = this.visitors.get(instanceId);
        if (!state) return;
        const delay = FOLLOW_INTERVAL_MIN + Math.random() * (FOLLOW_INTERVAL_MAX - FOLLOW_INTERVAL_MIN);
        state.behaviorTimer = setTimeout(() => {
            this.makeFollowDecision(instanceId);
            this.scheduleNextFollowDecision(instanceId);
        }, delay);
    }

    /** S4：读取主人活动，按决策表+personality 权重选择访客行为并执行 */
    private makeFollowDecision(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        // 社交活动进行中不打断
        if (state.data.activity === 'chatting' || state.data.activity === 'playing') return;

        const snap = this.gardenManager.getSnapshot();
        const hostActivity = snap.avatar.activity;
        const hostX = snap.avatar.x;

        const decision = this.chooseVisitorActivity(hostActivity, hostX, state.personality);
        state.avatar.moveTo(decision.x, decision.y);
        state.avatar.setActivity(decision.activity);
        state.data.activity = decision.activity;
    }

    /** S4 决策表：主人活动 → 访客选项（按 personality 权重）
     *  有花盆时，部分选项会注入"走向花盆"（浇水/拍照）的行为 */
    private chooseVisitorActivity(
        hostActivity: AvatarActivity,
        hostX: number,
        personality: Neighbor['personality'] | null,
    ): { activity: AvatarActivity; x: number; y: number } {
        const act = personality?.activity ?? 0.5;
        const soc = personality?.sociability ?? 0.5;
        // 随机选一个有植物的花盆（供访客走向花盆的选项）
        const potX = this.pickPlantedPotX();

        let opts: DecisionOption[] = [];
        switch (hostActivity) {
            case 'watering':
                opts = [
                    { activity: 'watering', weight: 0.3 + act * 0.4, near: false },
                    { activity: 'walking', weight: 0.2 + soc * 0.3, near: true },
                    { activity: 'idle', weight: 0.2, near: true },
                ];
                // 主人在浇水 → 访客也去花盆边浇水（协作）
                if (potX !== null) {
                    opts.push({ activity: 'watering', weight: 0.25 + act * 0.2, near: false, potX });
                }
                break;
            case 'reading':
                opts = [
                    { activity: 'reading', weight: 0.3 + act * 0.2, near: true },
                    { activity: 'idle', weight: 0.3, near: true },
                    { activity: 'walking', weight: 0.2 + soc * 0.2, near: false },
                ];
                break;
            case 'resting':
                opts = [
                    { activity: 'resting', weight: 0.2 + act * 0.2, near: true },
                    { activity: 'idle', weight: 0.3, near: true },
                    { activity: 'walking', weight: 0.2, near: false },
                ];
                break;
            case 'planting':
                opts = [
                    { activity: 'walking', weight: 0.3 + soc * 0.2, near: true },
                    { activity: 'idle', weight: 0.3, near: true },
                ];
                // 主人在种植 → 访客去旁边花盆拍照留念
                if (potX !== null) {
                    opts.push({ activity: 'photographing', weight: 0.2 + soc * 0.2, near: false, potX });
                }
                break;
            case 'harvesting':
                opts = [
                    { activity: 'harvesting', weight: 0.2 + act * 0.4, near: false },
                    { activity: 'walking', weight: 0.2 + soc * 0.2, near: true },
                    { activity: 'idle', weight: 0.2, near: true },
                ];
                // 主人在收获 → 访客去花盆边拍照记录
                if (potX !== null) {
                    opts.push({ activity: 'photographing', weight: 0.25 + soc * 0.2, near: false, potX });
                }
                break;
            case 'idle':
                opts = [
                    { activity: 'walking', weight: 0.2 + soc * 0.2, near: false },
                    { activity: 'idle', weight: 0.3, near: true },
                    { activity: 'walking', weight: 0.2 + soc * 0.3, near: true },
                ];
                // 主人发呆 → 访客偶尔去花盆边拍照或浇水
                if (potX !== null) {
                    opts.push({ activity: 'photographing', weight: 0.15, near: false, potX });
                    opts.push({ activity: 'watering', weight: 0.15 + act * 0.2, near: false, potX });
                }
                break;
            case 'walking':
                opts = [
                    { activity: 'walking', weight: 0.3 + soc * 0.3, near: true },
                    { activity: 'walking', weight: 0.3, near: false },
                ];
                // 主人在散步 → 访客也走到花盆边看看
                if (potX !== null) {
                    opts.push({ activity: 'walking', weight: 0.2, near: false, potX });
                }
                break;
            case 'playing':
                opts = [
                    { activity: 'playing', weight: 0.5 + soc * 0.3, near: true },
                    { activity: 'walking', weight: 0.2, near: true },
                ];
                break;
            case 'chatting':
                opts = [
                    { activity: 'chatting', weight: 0.4 + soc * 0.4, near: true },
                    { activity: 'idle', weight: 0.2, near: true },
                ];
                break;
            default:
                opts = [
                    { activity: 'idle', weight: 0.4, near: true },
                    { activity: 'walking', weight: 0.3, near: false },
                ];
        }

        // 加权随机选择
        const total = opts.reduce((s, o) => s + o.weight, 0);
        let r = Math.random() * total;
        let chosen = opts[0];
        for (const o of opts) {
            r -= o.weight;
            if (r <= 0) { chosen = o; break; }
        }

        // S5：协作点定位
        const point = this.getCollaborationPoint(chosen, hostX);
        return { activity: chosen.activity, ...point };
    }

    /** S5：根据决策选项计算目标坐标
     *  potX → 花盆旁边；near=true → 主人旁边 40-80px；near=false → 屏幕随机点
     */
    private getCollaborationPoint(
        opt: DecisionOption,
        hostX: number,
    ): { x: number; y: number } {
        // 走向花盆（优先级最高）
        if (opt.potX !== undefined) {
            const offset = 45;
            const x = opt.potX + (Math.random() < 0.5 ? -offset : offset);
            return {
                x: Math.max(50, Math.min(window.innerWidth - 50, x)),
                y: this.getGroundY(),
            };
        }
        if (opt.near) {
            const offset = 40 + Math.random() * 40;
            const x = hostX + (Math.random() < 0.5 ? -offset : offset);
            return {
                x: Math.max(50, Math.min(window.innerWidth - 50, x)),
                y: this.getGroundY(),
            };
        }
        return {
            x: window.innerWidth * (0.15 + Math.random() * 0.7),
            y: this.getGroundY(),
        };
    }

    /** 随机选一个有植物的花盆的 X 坐标，无植物花盆或无花盆时返回 null */
    private pickPlantedPotX(): number | null {
        const pots = this.gardenManager.getSnapshot().pots;
        if (pots.length === 0) return null;
        // 优先选有植物的花盆
        const planted = pots.filter(p => p.plantId);
        const pool = planted.length > 0 ? planted : pots;
        return pool[Math.floor(Math.random() * pool.length)].x;
    }

    /** S6：主人活动变化时所有访客立即重新决策（不等下个周期） */
    private onHostActivityChanged(_hostActivity: AvatarActivity): void {
        for (const [instanceId, state] of this.visitors) {
            if (state.data.phase !== 'visiting') continue;
            if (state.data.activity === 'chatting') continue;
            if (state.behaviorTimer) {
                clearTimeout(state.behaviorTimer);
                state.behaviorTimer = null;
            }
            this.makeFollowDecision(instanceId);
            this.scheduleNextFollowDecision(instanceId);
        }
    }

    // ─── 离开 ────────────────────────────────────────────────────

    private scheduleLeaveCheck(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        const remaining = state.data.leaveAt - Date.now();
        if (remaining <= 0) {
            this.enterLeaving(instanceId);
        } else {
            state.leaveTimer = setTimeout(() => {
                this.scheduleLeaveCheck(instanceId);
            }, Math.min(remaining, 10_000));
        }
    }

    private enterLeaving(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        if (state.behaviorTimer) {
            clearTimeout(state.behaviorTimer);
            state.behaviorTimer = null;
        }
        state.avatar.setPhase('leaving');
        state.avatar.setActivity('walking');
        // 走向最近的屏幕边缘外
        const exitX = state.data.x < window.innerWidth / 2 ? -80 : window.innerWidth + 80;
        state.avatar.moveTo(exitX, this.getGroundY());

        // LEAVING_EXIT_DURATION 后销毁
        state.behaviorTimer = setTimeout(() => {
            this.removeVisitor(instanceId);
        }, LEAVING_EXIT_DURATION);
    }

    private removeVisitor(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        if (state.behaviorTimer) {
            clearTimeout(state.behaviorTimer);
            state.behaviorTimer = null;
        }
        if (state.leaveTimer) {
            clearTimeout(state.leaveTimer);
            state.leaveTimer = null;
        }
        state.avatar.destroy();
        this.visitors.delete(instanceId);
        // 释放本地 NPC 占用（允许再次出现）
        if (this.usingLocalFallback) {
            this.availableLocalNpcIds.push(state.data.memberId);
        }
        this.onVisitorLeft?.(instanceId);
    }

    private removeAllVisitors(): void {
        for (const instanceId of Array.from(this.visitors.keys())) {
            this.removeVisitor(instanceId);
        }
    }

    // ─── 交互 ────────────────────────────────────────────────────

    /** S7：点击访客 → 主角和该访客都进入 chatting */
    private handleVisitorClick(instanceId: string): void {
        const state = this.visitors.get(instanceId);
        if (!state) return;
        if (state.data.phase !== 'visiting') return;
        // 打断当前跟随循环，进入 chatting
        if (state.behaviorTimer) {
            clearTimeout(state.behaviorTimer);
            state.behaviorTimer = null;
        }
        state.avatar.setActivity('chatting');
        state.data.activity = 'chatting';
        void this.gardenManager.setAvatarActivity('chatting', 'social');

        // CHAT_DURATION 后恢复跟随循环
        state.behaviorTimer = setTimeout(() => {
            this.enterFollowLoop(instanceId);
        }, CHAT_DURATION);
    }

    // ─── 查询 ────────────────────────────────────────────────────

    getVisitors(): ActiveVisitor[] {
        return Array.from(this.visitors.values()).map(s => ({ ...s.data }));
    }

    getVisitorCount(): number {
        return this.visitors.size;
    }

    hasVisitors(): boolean {
        return this.visitors.size > 0;
    }

    // ─── 每帧更新 ────────────────────────────────────────────────

    update(): void {
        // VisitorAvatar 内部有 tick，无需这里更新
    }
}

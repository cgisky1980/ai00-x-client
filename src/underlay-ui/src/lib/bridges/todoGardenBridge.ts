/**
 * 跨层桥：待办插件里程碑 → 微花园（todoGardenBridge）。
 *
 * overlay 层的待办插件通过宿主命令 `plugin_emit_event` 广播命名空间事件
 * `plugin://com.ai00x.todo/*`；本桥在 underlay 桌面层监听并转成花园动作：
 *  - focus-completed（专注完成）→ 给最需要水的那株植物浇水
 *  - badge-unlocked（勋章解锁）→ 收集册新增「礼物」条目（勋章纪念）
 *
 * 花园未启用/未初始化时静默空转（无副作用）。
 */
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getGardenManager } from '../world/GardenManager';
import type { Plant } from '../world/types';

const TODO_EVENT_PREFIX = 'plugin://com.ai00x.todo/';

interface FocusCompletedPayload {
    minutes?: number;
    outcome?: string;
}

interface BadgeUnlockedPayload {
    badgeId?: string;
    name?: string;
    tier?: string;
}

/** 找一株最值得浇水的活植物：优先枯萎临界(最久未浇)，其次任意未枯萎。 */
function pickThirstyPlant(plants: Plant[]): Plant | null {
    const alive = plants.filter((p) => !p.harvested && p.stage !== 'wilting' && p.stage !== 'seed');
    if (!alive.length) return null;
    return [...alive].sort((a, b) => (a.lastWateredAt || 0) - (b.lastWateredAt || 0))[0];
}

export function useTodoGardenBridge(): void {
    useEffect(() => {
        const offs: Array<() => void> = [];

        (async () => {
            try {
                // 专注完成 → 浇水（花园懒初始化，幂等）。
                offs.push(
                    await listen<FocusCompletedPayload>(`${TODO_EVENT_PREFIX}focus-completed`, async () => {
                        try {
                            const mgr = getGardenManager();
                            await mgr.init();
                            const plant = pickThirstyPlant(mgr.getSnapshot().plants);
                            if (plant) await mgr.waterPlant(plant.id);
                        } catch {
                            // 花园不可用（未启用桌面宠物等）→ 静默。
                        }
                    }),
                );

                // 勋章解锁 → 收集册礼物（即使花园暂无植物也记录，重开可见）。
                offs.push(
                    await listen<BadgeUnlockedPayload>(`${TODO_EVENT_PREFIX}badge-unlocked`, async (e) => {
                        try {
                            const { badgeId, name, tier } = e.payload || {};
                            if (!badgeId) return;
                            const mgr = getGardenManager();
                            await mgr.init();
                            await mgr.addCollectionItem(
                                'gift',
                                `todo-badge:${badgeId}`,
                                'visitor',
                                `待办勋章 · ${name || badgeId}（${tier || 'bronze'}）`,
                            );
                        } catch {
                            // 静默。
                        }
                    }),
                );
            } catch {
                // listen 注册失败（如测试环境）→ 静默。
            }
        })();

        return () => {
            for (const off of offs) off();
        };
    }, []);
}

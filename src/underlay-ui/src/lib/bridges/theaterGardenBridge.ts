/**
 * 跨层桥：Agent 剧场结算 → 微花园（theaterGardenBridge，设计 §4.3）。
 *
 * web-ui 的工灵悬浮窗（AgentTheaterWidget）在 turn 结束/名场面命中时
 * Tauri 全局 emit 结算级事件；本桥在 underlay 桌面层监听并转成花园动作：
 *  - theater://turn-ended（outcome=success）→ 桌面随机位置庆祝痕迹
 *    （sparkle/flower_petals；failed/cancelled 不惩罚，无动作）
 *  - theater://scene → 图鉴 diary 条目（名场面卡，source='agent'）
 *
 * 边界：原始工具事件永不过桥（设计 §1）；花园未启用时静默空转
 * （模式同 todoGardenBridge）。
 */
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getGardenManager } from '../world/GardenManager';
import type { TraceType } from '../world/types';

interface TurnEndedPayload {
  sessionId: string;
  turnId: string;
  outcome: 'success' | 'failed';
  taskLabel: string;
  stats: {
    toolCalls: number;
    errors: number;
    durationMs: number;
    taskLabel: string;
  };
}

interface ScenePayload {
  sessionId: string;
  turnId: string;
  ruleKey: string;
  detail: {
    toolCalls: number;
    errors: number;
    durationMs: number;
    taskLabel: string;
  };
}

/** 庆祝痕迹随机取一（deliver 氛围） */
const CELEBRATION_TRACES: TraceType[] = ['sparkle', 'flower_petals'];

function randomCelebrateTrace(): TraceType {
  return CELEBRATION_TRACES[Math.floor(Math.random() * CELEBRATION_TRACES.length)];
}

export function useTheaterGardenBridge(): void {
  useEffect(() => {
    const offs: Array<() => void> = [];

    (async () => {
      try {
        // 交付成功 → 桌面庆祝痕迹（失败不惩罚）
        offs.push(
          await listen<TurnEndedPayload>('theater://turn-ended', async (e) => {
            try {
              if (e.payload?.outcome !== 'success') return;
              const mgr = getGardenManager();
              await mgr.init();
              mgr.addTrace(
                randomCelebrateTrace(),
                window.innerWidth * (0.15 + Math.random() * 0.7),
                window.innerHeight * (0.5 + Math.random() * 0.3),
                'self',
                1_800_000, // 30 分钟自动消失
                'agent-theater',
              );
            } catch {
              // 花园不可用 → 静默
            }
          }),
        );

        // 名场面卡 → 图鉴 diary（source='agent'）
        offs.push(
          await listen<ScenePayload>('theater://scene', async (e) => {
            try {
              const p = e.payload;
              if (!p?.turnId || !p.ruleKey) return;
              const mgr = getGardenManager();
              await mgr.init();
              const minutes = Math.max(1, Math.round(p.detail.durationMs / 60_000));
              const detail = `${p.detail.taskLabel || 'agent'} · ${minutes} 分钟 · ${p.detail.toolCalls} 件活 · ${p.detail.errors} 次翻车`;
              await mgr.addCollectionItem('diary', `agent-scene:${p.turnId}`, 'agent', detail, 1);
            } catch {
              // 静默
            }
          }),
        );
      } catch {
        // listen 注册失败（如测试环境）→ 静默
      }
    })();

    return () => {
      for (const off of offs) off();
    };
  }, []);
}

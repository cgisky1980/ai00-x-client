/**
 * windowBus — 跨窗口（BroadcastChannel）消息总线。
 *
 * 与 `SettingsSyncService` 同机制，但泛化为通用总线：那个服务专职同步
 * theme / language / workspace 三件事，而「同一份数据被两个窗口同时读写」
 * （例：策运行时留在 overlay 窗口、策看板在独立窗口）需要一类更通用的通道。
 *
 * 特性：
 * - **懒初始化**：首次 publish / subscribe 时建 channel，无需显式 start；
 * - **回声抑制**：发送方带 `WINDOW_BUS_SOURCE_ID`，接收侧自动丢弃自己发出去的消息，
 *   调用方不用自己判重；
 * - **多订阅者**：同一窗口可有多个订阅者（如 todo 数据同步 + 运行态同步）。
 *
 * 注意 BroadcastChannel 只在同源页面间生效——本项目所有窗口都从
 * `local_web_origin()` 加载，因此天然同源。
 */
import { createLogger } from '../../shared/utils/logger';

const log = createLogger('WindowBus');

const CHANNEL_NAME = 'ai00-x-window-bus';

/** 本页面（窗口）的随机 id，用于抑制自己发出的消息回声 */
export const WINDOW_BUS_SOURCE_ID = `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export interface WindowBusMessage<T = unknown> {
  /** 消息类型，约定 `<域>:<事件>`，如 `todo:data-changed` */
  type: string;
  /** 发送方窗口 id */
  source: string;
  payload?: T;
}

type WindowBusListener = (message: WindowBusMessage) => void;

const listeners = new Set<WindowBusListener>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): void {
  if (channel) return;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<WindowBusMessage>) => {
      const message = event.data;
      if (!message || message.source === WINDOW_BUS_SOURCE_ID) return;
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          log.warn('window bus listener failed', error);
        }
      }
    };
  } catch (error) {
    log.warn('BroadcastChannel unavailable, cross-window sync disabled', error);
  }
}

/** 广播一条消息（本窗口的订阅者不会收到自己的消息） */
export function publishWindowMessage<T>(type: string, payload?: T): void {
  ensureChannel();
  if (!channel) return;
  const message: WindowBusMessage<T> = {
    type,
    source: WINDOW_BUS_SOURCE_ID,
    payload,
  };
  channel.postMessage(message);
}

/** 订阅跨窗口消息，返回退订函数 */
export function subscribeWindowMessage(listener: WindowBusListener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// 待处理意图（pending intents）
// ---------------------------------------------------------------------------
/**
 * 解决「目标窗口尚未打开」的时序问题。
 *
 * BroadcastChannel 只投递给**已存在**的页面。当用户点击 overlay 上的工灵、
 * 而策窗口还没开时，直接广播会石沉大海。做法是：
 *
 * 1. 发送侧先 `queueWindowIntent(type, payload)` 落到 `sessionStorage`，
 *    然后 `publishWindowMessage` 尝试即时投递；
 * 2. 目标窗口启动（`bootstrapWindowPage` 挂载完成）后调
 *    `takePendingIntents(type)`，取走并清空——无论它是早就在跑（即时投递
 *    已生效，pending 为空）还是刚被拉起（取到刚入队的那条）。
 *
 * 用 `sessionStorage` 而非 `localStorage`：意图是"这一次操作"的，不应跨
 * 应用重启存活。注意 `sessionStorage` 按标签页隔离，但 Tauri 各窗口共享同一
 * webview 进程的 storage 分区——本项目实测可跨窗口读（与 `SettingsSyncService`
 * 的前提一致）；若日后发现隔离，可改 `localStorage` + 时间戳过期兜底。
 */
const INTENT_KEY_PREFIX = 'ai00.window-intent.';

/** 意图存活上限：超过则视为过期丢弃，避免陈旧意图在新窗口里"诈尸" */
const INTENT_TTL_MS = 10_000;

interface StoredIntent<T = unknown> {
  payload?: T;
  at: number;
}

/**
 * 暂存一条意图，供稍后启动的窗口消费。
 *
 * 注意：不做"已投递就删"的乐观清理——无法得知当前是否已有订阅者。
 * 由消费侧 `takePendingIntents` 负责清空，且带 TTL 防止无限堆积。
 */
export function queueWindowIntent<T>(type: string, payload?: T): void {
  try {
    const stored: StoredIntent<T> = { payload, at: Date.now() };
    sessionStorage.setItem(INTENT_KEY_PREFIX + type, JSON.stringify(stored));
  } catch (error) {
    log.warn('queueWindowIntent failed', error);
  }
}

/**
 * 取走并清空指定类型的待处理意图（窗口启动时调用）。
 *
 * @returns 未过期的意图数组（0 或 1 条——同类型只保留最后一次操作，
 *          因为"去 A 卡"立刻被"去 B 卡"覆盖是符合直觉的）
 */
export function takePendingIntents<T>(type: string): T[] {
  const key = INTENT_KEY_PREFIX + type;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    sessionStorage.removeItem(key);
    const stored = JSON.parse(raw) as StoredIntent<T>;
    if (!stored || typeof stored.at !== 'number') return [];
    if (Date.now() - stored.at > INTENT_TTL_MS) {
      log.warn(`pending intent expired: ${type}`);
      return [];
    }
    return stored.payload === undefined ? [] : [stored.payload];
  } catch (error) {
    log.warn('takePendingIntents failed', error);
    return [];
  }
}


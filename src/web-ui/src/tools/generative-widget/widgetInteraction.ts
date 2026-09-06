import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import path from 'path-browserify';
import { fileTabManager } from '@/shared/services/FileTabManager';
import { notificationService } from '@/shared/notification-system';

/** 活跃会话快照（由交互触发时刷新，异步拉最近 dsh 会话） */
const widgetState: { activeSessionId: string | null; activeWorkspacePath?: string } = {
  activeSessionId: null,
  activeWorkspacePath: undefined,
};

async function refreshWidgetState(): Promise<void> {
  try {
    const { dshSession } = await import('@/infrastructure/api/service-api/DshAPI');
    const { items } = await dshSession.list();
    const latest = [...items].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    widgetState.activeSessionId = latest?.sessionId ?? null;
    widgetState.activeWorkspacePath = latest?.cwd ?? undefined;
  } catch {
    // 引擎未启动 → 保持
  }
}

void refreshWidgetState();
const log = createLogger('widgetInteraction');

export type WidgetBridgeEvent =
  | {
      type: 'ai00-x-widget:prompt';
      widgetId?: string;
      text?: string;
    }
  | {
      type: 'ai00-x-widget:event';
      widgetId?: string;
      payload?: unknown;
    }
  | {
      type: 'ai00-x-widget:open-file';
      widgetId?: string;
      filePath?: string;
      line?: number;
      column?: number;
      lineEnd?: number;
      nodeType?: string;
    };

export interface WidgetInteractionDetail {
  sessionId: string | null;
  widgetId?: string;
  source: 'tool-card' | 'panel';
  interactionType: 'prompt' | 'event';
  text?: string;
  payload?: unknown;
}

function getActiveSessionId(): string | null {
  return widgetState.activeSessionId;
}

function getActiveWorkspacePath(): string | undefined {
  return widgetState.activeWorkspacePath;
}



function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function emitInteraction(detail: WidgetInteractionDetail): void {
  globalEventBus.emit<WidgetInteractionDetail>('widget:interaction', detail, 'widgetInteraction');
}

function normalizeFileTarget(filePath: string, workspacePath?: string): string {
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(filePath);
  if (isWindowsAbsolutePath || path.isAbsolute(filePath) || !workspacePath) {
    return filePath;
  }

  return path.join(workspacePath, filePath);
}

export function handleWidgetBridgeEvent(
  event: WidgetBridgeEvent | null | undefined,
  source: 'tool-card' | 'panel',
): void {
  if (!event) return;

  const sessionId = getActiveSessionId();

  if (event.type === 'ai00-x-widget:prompt') {
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) return;

    emitInteraction({
      sessionId,
      widgetId: event.widgetId,
      source,
      interactionType: 'prompt',
      text,
    });

    void (async () => {
      try {
        if (!sessionId) return;
        const { dshSession } = await import('@/infrastructure/api/service-api/DshAPI');
        await dshSession.prompt(sessionId, text);
      } catch (error) {
        log.warn('Auto-send from widget prompt failed, falling back to chat input', {
          sessionId,
          widgetId: event.widgetId,
          error,
        });
        globalEventBus.emit('fill-chat-input', { content: text }, 'widgetInteraction');
      }
    })();
    return;
  }

  if (event.type === 'ai00-x-widget:open-file') {
    const filePath = typeof event.filePath === 'string' ? event.filePath.trim() : '';
    if (!filePath) return;

    const sessionId = getActiveSessionId();
    const workspacePath = getActiveWorkspacePath();
    const absoluteFilePath = normalizeFileTarget(filePath, workspacePath);
    const line = typeof event.line === 'number' && event.line > 0 ? event.line : undefined;
    const column = typeof event.column === 'number' && event.column > 0 ? event.column : undefined;
    const lineEnd = typeof event.lineEnd === 'number' && event.lineEnd >= (line ?? 1) ? event.lineEnd : undefined;

    emitInteraction({
      sessionId,
      widgetId: event.widgetId,
      source,
      interactionType: 'event',
      payload: {
        action: 'open-file',
        filePath: absoluteFilePath,
        line,
        column,
        lineEnd,
        nodeType: event.nodeType,
      },
    });

    try {
      if (line && lineEnd && lineEnd > line) {
        fileTabManager.openFile({
          filePath: absoluteFilePath,
          workspacePath,
          jumpToRange: { start: line, end: lineEnd },
          mode: 'agent',
        });
      } else if (line) {
        fileTabManager.openFileAndJump(absoluteFilePath, line, column, {
          workspacePath,
          mode: 'agent',
        });
      } else {
        fileTabManager.openFile({
          filePath: absoluteFilePath,
          workspacePath,
          mode: 'agent',
        });
      }
    } catch (error) {
      log.error('Widget file navigation failed', {
        source,
        sessionId,
        widgetId: event.widgetId,
        filePath: absoluteFilePath,
        error,
      });
      notificationService.error(`Unable to open file: ${absoluteFilePath}`);
    }
    return;
  }

  if (event.type === 'ai00-x-widget:event' && event.payload !== undefined) {
    emitInteraction({
      sessionId,
      widgetId: event.widgetId,
      source,
      interactionType: 'event',
      payload: event.payload,
    });

    const payloadText = stringifyPayload(event.payload);
    globalEventBus.emit(
      'fill-chat-input',
      {
        content: `Widget interaction:\n${payloadText}`,
      },
      'widgetInteraction',
    );
  }
}

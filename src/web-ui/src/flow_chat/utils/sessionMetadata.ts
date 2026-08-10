import { i18nService } from '@/infrastructure/i18n';
import type {
  SessionCustomMetadata,
  SessionMetadata,
} from '@/shared/types/session-history';
import type { Session } from '../types/flow-chat';

export function deriveLastFinishedAtFromMetadata(
  metadata?: Pick<SessionMetadata, 'customMetadata'> | null
): number | undefined {
  const value = metadata?.customMetadata?.lastFinishedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function calculateSessionStats(
  session: Pick<Session, 'dialogTurns'>
): Pick<SessionMetadata, 'turnCount' | 'messageCount' | 'toolCallCount'> {
  const turnCount = session.dialogTurns.length;
  const messageCount = session.dialogTurns.reduce((sum, turn) => {
    return (
      sum +
      1 +
      turn.modelRounds.reduce((roundSum, round) => {
        return roundSum + round.items.filter(item => item.type === 'text').length;
      }, 0)
    );
  }, 0);
  const toolCallCount = session.dialogTurns.reduce((sum, turn) => {
    return sum + turn.modelRounds.reduce((roundSum, round) => {
      return roundSum + round.items.filter(item => item.type === 'tool').length;
    }, 0);
  }, 0);

  return { turnCount, messageCount, toolCallCount };
}

function buildSessionCustomMetadata(
  session: Pick<Session, 'lastFinishedAt'>,
  existingCustomMetadata?: SessionCustomMetadata
): SessionCustomMetadata {
  const nextCustomMetadata: SessionCustomMetadata = {};

  for (const [key, value] of Object.entries(existingCustomMetadata || {})) {
    if (key !== 'lastFinishedAt') {
      nextCustomMetadata[key] = value;
    }
  }

  nextCustomMetadata.lastFinishedAt = session.lastFinishedAt ?? null;

  return nextCustomMetadata;
}

export function buildSessionMetadata(
  session: Pick<
    Session,
    | 'sessionId'
    | 'title'
    | 'mode'
    | 'config'
    | 'createdAt'
    | 'workspacePath'
    | 'remoteConnectionId'
    | 'remoteSshHost'
    | 'todos'
    | 'dialogTurns'
    | 'lastFinishedAt'
  >,
  existingMetadata?: SessionMetadata | null
): SessionMetadata {
  const stats = calculateSessionStats(session);

  return {
    ...existingMetadata,
    sessionId: session.sessionId,
    sessionName:
      session.title ||
      existingMetadata?.sessionName ||
      i18nService.t('flow-chat:session.new'),
    agentType:
      session.mode ||
      session.config.agentType ||
      existingMetadata?.agentType ||
      'Code',
    modelName:
      session.config.modelName || existingMetadata?.modelName || 'auto',
    createdAt: existingMetadata?.createdAt ?? session.createdAt,
    lastActiveAt: Date.now(),
    turnCount: Math.max(stats.turnCount, existingMetadata?.turnCount ?? 0),
    messageCount: Math.max(
      stats.messageCount,
      existingMetadata?.messageCount ?? 0
    ),
    toolCallCount: Math.max(
      stats.toolCallCount,
      existingMetadata?.toolCallCount ?? 0
    ),
    status: 'active',
    snapshotSessionId: existingMetadata?.snapshotSessionId,
    tags: Array.isArray(existingMetadata?.tags) ? [...existingMetadata!.tags!] : [],
    customMetadata: buildSessionCustomMetadata(
      session,
      existingMetadata?.customMetadata
    ),
    todos: session.todos || existingMetadata?.todos || [],
    workspacePath: session.workspacePath || existingMetadata?.workspacePath,
    remoteConnectionId:
      session.remoteConnectionId ?? existingMetadata?.remoteConnectionId,
    remoteSshHost: session.remoteSshHost ?? existingMetadata?.remoteSshHost,
  };
}

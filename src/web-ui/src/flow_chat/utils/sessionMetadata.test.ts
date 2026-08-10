import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import type { SessionMetadata } from '@/shared/types/session-history';

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

import {
  buildSessionMetadata,
  deriveLastFinishedAtFromMetadata,
} from './sessionMetadata';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    title: 'Session Title',
    titleStatus: 'generated',
    dialogTurns: [],
    status: 'idle',
    config: {
      modelName: 'gpt-test',
      agentType: 'Code',
    },
    createdAt: 1000,
    lastActiveAt: 1000,
    error: null,
    todos: [],
    maxContextTokens: 128128,
    mode: 'Code',
    workspacePath: '/workspace',
    lastFinishedAt: undefined,
    ...overrides,
  };
}

describe('sessionMetadata', () => {
  it('persists and restores lastFinishedAt without dropping unrelated metadata', () => {
    const session = createSession({
      lastFinishedAt: 4321,
    });

    const metadata = buildSessionMetadata(session, {
      sessionId: 'session-1',
      sessionName: 'Session Title',
      agentType: 'Code',
      modelName: 'gpt-test',
      createdAt: 1000,
      lastActiveAt: 1000,
      turnCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      status: 'active',
      tags: [],
      customMetadata: {
        unrelated: 'preserved',
      },
      todos: [],
      workspacePath: '/workspace',
    });

    expect(metadata.customMetadata).toEqual({
      unrelated: 'preserved',
      lastFinishedAt: 4321,
    });
    expect(deriveLastFinishedAtFromMetadata(metadata)).toBe(4321);
  });
});

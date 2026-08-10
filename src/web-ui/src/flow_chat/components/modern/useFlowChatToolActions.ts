/**
 * Tool confirmation/rejection actions for Modern FlowChat.
 */

import { useCallback } from 'react';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '../../store/FlowChatStore';
import type { DialogTurn, FlowItem, FlowToolItem, ModelRound } from '../../types/flow-chat';

const log = createLogger('useFlowChatToolActions');

interface ResolvedToolContext {
  activeSessionId: string | null;
  toolItem: FlowToolItem | null;
  turnId: string | null;
}

function resolveToolContext(toolId: string): ResolvedToolContext {
  const latestState = flowChatStore.getState();
  const dialogTurns = Array.from(latestState.sessions.values()).flatMap(session =>
    session.dialogTurns as DialogTurn[],
  );

  let toolItem: FlowToolItem | null = null;
  let turnId: string | null = null;

  for (const turn of dialogTurns) {
    for (const modelRound of turn.modelRounds as ModelRound[]) {
      const item = modelRound.items.find((candidate: FlowItem) => (
        candidate.type === 'tool' && candidate.id === toolId
      )) as FlowToolItem | undefined;

      if (item) {
        toolItem = item;
        turnId = turn.id;
        break;
      }
    }

    if (toolItem) {
      break;
    }
  }

  return {
    activeSessionId: latestState.activeSessionId,
    toolItem,
    turnId,
  };
}

export function useFlowChatToolActions() {
  const handleToolConfirm = useCallback(async (toolId: string, updatedInput?: any) => {
    try {
      const { activeSessionId, toolItem, turnId } = resolveToolContext(toolId);

      if (!toolItem || !turnId) {
        notificationService.error(`Tool confirmation failed: tool item ${toolId} not found in current task`);
        return;
      }

      const finalInput = updatedInput || toolItem.toolCall?.input;

      if (activeSessionId) {
        flowChatStore.updateModelRoundItem(activeSessionId, turnId, toolId, {
          userConfirmed: true,
          status: 'confirmed',
          toolCall: {
            ...toolItem.toolCall,
            input: finalInput,
          },
        } as any);
      }

      if (!activeSessionId) {
        throw new Error('No active session ID');
      }

      const { agentService } = await import('../../../shared/services/agent-service');
      await agentService.confirmToolExecution(
        activeSessionId,
        toolId,
        'confirm',
        finalInput,
      );
    } catch (error) {
      log.error('Tool confirmation failed', error);
      notificationService.error(`Tool confirmation failed: ${error}`);
    }
  }, []);

  const handleToolReject = useCallback(async (toolId: string) => {
    try {
      const { activeSessionId, toolItem, turnId } = resolveToolContext(toolId);

      if (!toolItem || !turnId) {
        log.warn('Tool rejection failed: tool item not found', { toolId });
        return;
      }

      if (activeSessionId) {
        flowChatStore.updateModelRoundItem(activeSessionId, turnId, toolId, {
          userConfirmed: false,
          status: 'rejected',
        } as any);
      }

      if (!activeSessionId) {
        throw new Error('No active session ID');
      }

      const { agentService } = await import('../../../shared/services/agent-service');
      await agentService.confirmToolExecution(
        activeSessionId,
        toolId,
        'reject',
      );
    } catch (error) {
      log.error('Tool rejection failed', error);
      notificationService.error(`Tool rejection failed: ${error}`);
    }
  }, []);

  return {
    handleToolConfirm,
    handleToolReject,
  };
}

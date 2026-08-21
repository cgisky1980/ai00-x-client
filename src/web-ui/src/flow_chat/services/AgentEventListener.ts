/**
 * Agent event listener
 * Listens to backend agent:// events and dispatches them to the frontend
 * 
 * Architecture:
 * - Uses unified agentAPI (based on ApiClient) for event listening
 * - ApiClient internally uses TransportAdapter, supporting multiple platforms
 */

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type { TextChunkEvent, ToolEvent, AgentEvent, SessionTitleGeneratedEvent, ImageAnalysisEvent, WorkflowPhaseChangedEvent, PlanConfirmationNeededEvent, PlanConfirmationRespondedEvent, PlanAutoReviewStartedEvent, PlanAutoReviewCompletedEvent, PlanReviseRequestedEvent } from '@/infrastructure/api/service-api/AgentAPI';
import { createLogger } from '@/shared/utils/logger';

type UnlistenFn = () => void;

const logger = createLogger('AgentEventListener');

export interface AgentEventCallbacks {
  onSessionCreated?: (event: AgentEvent) => void;
  onSessionDeleted?: (event: AgentEvent) => void;
  onSessionStateChanged?: (event: AgentEvent) => void;
  onImageAnalysisStarted?: (event: ImageAnalysisEvent) => void;
  onImageAnalysisCompleted?: (event: ImageAnalysisEvent) => void;
  onDialogTurnStarted?: (event: AgentEvent) => void;
  onModelRoundStarted?: (event: AgentEvent) => void;
  onModelRoundCompleted?: (event: AgentEvent) => void;
  onTextChunk?: (event: TextChunkEvent) => void;
  onToolEvent?: (event: ToolEvent) => void;
  onDialogTurnCompleted?: (event: AgentEvent) => void;
  onDialogTurnFailed?: (event: AgentEvent) => void;
  onDialogTurnCancelled?: (event: AgentEvent) => void;
  onTokenUsageUpdated?: (event: AgentEvent) => void;
  onContextCompressionStarted?: (event: AgentEvent) => void;
  onContextCompressionCompleted?: (event: AgentEvent) => void;
  onContextCompressionFailed?: (event: AgentEvent) => void;
  onSessionTitleGenerated?: (event: SessionTitleGeneratedEvent) => void;
  onWorkflowPhaseChanged?: (event: WorkflowPhaseChangedEvent) => void;
  onPlanConfirmationNeeded?: (event: PlanConfirmationNeededEvent) => void;
  onPlanConfirmationResponded?: (event: PlanConfirmationRespondedEvent) => void;
  onPlanAutoReviewStarted?: (event: PlanAutoReviewStartedEvent) => void;
  onPlanAutoReviewCompleted?: (event: PlanAutoReviewCompletedEvent) => void;
  onPlanReviseRequested?: (event: PlanReviseRequestedEvent) => void;
}

export class AgentEventListener {
  private unlistenFunctions: UnlistenFn[] = [];
  private isListening = false;

  async startListening(callbacks: AgentEventCallbacks): Promise<void> {
    if (this.isListening) {
      logger.warn('Event listener already running');
      return;
    }

    logger.info('Starting Agent event listener');

    try {
      if (callbacks.onSessionCreated) {
        const unlisten = agentAPI.onSessionCreated((event) => {
          logger.debug('Session created:', event);
          callbacks.onSessionCreated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionDeleted) {
        const unlisten = agentAPI.onSessionDeleted((event) => {
          logger.debug('Session deleted:', event);
          callbacks.onSessionDeleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionStateChanged) {
        const unlisten = agentAPI.onSessionStateChanged((event) => {
          logger.debug('Session state changed:', event);
          callbacks.onSessionStateChanged?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onImageAnalysisStarted) {
        const unlisten = agentAPI.onImageAnalysisStarted((event) => {
          logger.debug('Image analysis started:', event);
          callbacks.onImageAnalysisStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onImageAnalysisCompleted) {
        const unlisten = agentAPI.onImageAnalysisCompleted((event) => {
          logger.debug('Image analysis completed:', event);
          callbacks.onImageAnalysisCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnStarted) {
        const unlisten = agentAPI.onDialogTurnStarted((event) => {
          logger.debug('Dialog turn started:', event);
          callbacks.onDialogTurnStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onModelRoundStarted) {
        const unlisten = agentAPI.onModelRoundStarted((event) => {
          logger.debug('Model round started:', event);
          callbacks.onModelRoundStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onModelRoundCompleted) {
        const unlisten = agentAPI.onModelRoundCompleted((event) => {
          logger.debug('Model round completed:', event);
          callbacks.onModelRoundCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onTextChunk) {
        const unlisten = agentAPI.onTextChunk((event) => {
          callbacks.onTextChunk?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onToolEvent) {
        const unlisten = agentAPI.onToolEvent((event) => {
          callbacks.onToolEvent?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnCompleted) {
        const unlisten = agentAPI.onDialogTurnCompleted((event) => {
          logger.debug('Dialog turn completed:', event);
          callbacks.onDialogTurnCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnFailed) {
        const unlisten = agentAPI.onDialogTurnFailed((event) => {
          logger.error('Dialog turn failed:', event);
          callbacks.onDialogTurnFailed?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnCancelled) {
        const unlisten = agentAPI.onDialogTurnCancelled((event) => {
          logger.debug('Dialog turn cancelled:', event);
          callbacks.onDialogTurnCancelled?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onTokenUsageUpdated) {
        const unlisten = agentAPI.onTokenUsageUpdated((event) => {
          logger.debug('Token usage updated:', event);
          callbacks.onTokenUsageUpdated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onContextCompressionStarted) {
        const unlisten = agentAPI.onContextCompressionStarted((event) => {
          logger.debug('Context compression started:', event);
          callbacks.onContextCompressionStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onContextCompressionCompleted) {
        const unlisten = agentAPI.onContextCompressionCompleted((event) => {
          logger.debug('Context compression completed:', event);
          callbacks.onContextCompressionCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onContextCompressionFailed) {
        const unlisten = agentAPI.onContextCompressionFailed((event) => {
          logger.error('Context compression failed:', event);
          callbacks.onContextCompressionFailed?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionTitleGenerated) {
        const unlisten = agentAPI.onSessionTitleGenerated((event) => {
          logger.debug('Session title generated:', event);
          callbacks.onSessionTitleGenerated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onWorkflowPhaseChanged) {
        const unlisten = agentAPI.onWorkflowPhaseChanged((event) => {
          logger.debug('WorkflowPhaseChanged:', event);
          callbacks.onWorkflowPhaseChanged?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onPlanConfirmationNeeded) {
        const unlisten = agentAPI.onPlanConfirmationNeeded((event) => {
          logger.debug('PlanConfirmationNeeded:', event);
          callbacks.onPlanConfirmationNeeded?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onPlanConfirmationResponded) {
        const unlisten = agentAPI.onPlanConfirmationResponded((event) => {
          logger.debug('PlanConfirmationResponded:', event);
          callbacks.onPlanConfirmationResponded?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onPlanAutoReviewStarted) {
        const unlisten = agentAPI.onPlanAutoReviewStarted((event) => {
          logger.debug('PlanAutoReviewStarted:', event);
          callbacks.onPlanAutoReviewStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onPlanAutoReviewCompleted) {
        const unlisten = agentAPI.onPlanAutoReviewCompleted((event) => {
          logger.debug('PlanAutoReviewCompleted:', event);
          callbacks.onPlanAutoReviewCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onPlanReviseRequested) {
        const unlisten = agentAPI.onPlanReviseRequested((event) => {
          logger.debug('PlanReviseRequested:', event);
          callbacks.onPlanReviseRequested?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      this.isListening = true;
      logger.info(`Registered ${this.unlistenFunctions.length} event listeners`);
    } catch (error) {
      logger.error('Failed to register event listeners:', error);
      await this.stopListening();
      throw error;
    }
  }

  async stopListening(): Promise<void> {
    if (!this.isListening) {
      return;
    }

    logger.info('Stopping Agent event listener');

    for (const unlisten of this.unlistenFunctions) {
      try {
        unlisten();
      } catch (error) {
        logger.error('Failed to unlisten:', error);
      }
    }

    this.unlistenFunctions = [];
    this.isListening = false;
    logger.info('Stopped all event listeners');
  }

  getIsListening(): boolean {
    return this.isListening;
  }
}

export const agentEventListener = new AgentEventListener();


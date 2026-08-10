 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type { ImageContextData as ImageInputContextData } from './ImageContextTypes';



export interface SessionTitleGeneratedEvent {
  sessionId: string;
  title: string;
  method: 'ai' | 'fallback';
  timestamp: number;
}

 
export interface SessionConfig {
  modelName?: string;
  maxContextTokens?: number;
  autoCompact?: boolean;
  enableTools?: boolean;
  safeMode?: boolean;
  maxTurns?: number;
  enableContextCompression?: boolean;
  compressionThreshold?: number;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

 
export interface CreateSessionRequest {
  sessionId?: string; 
  sessionName: string;
  agentType: string;
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  config?: SessionConfig;
  creationId?: string;
}

 
export interface CreateSessionResponse {
  sessionId: string;
  sessionName: string;
  agentType: string;
  sandboxBranch?: string;
  sandboxError?: string;
}

 
export interface StartDialogTurnRequest {
  sessionId: string;
  userInput: string;
  originalUserInput?: string;
  turnId?: string; 
  agentType: string; 
  workspacePath?: string;
  /** Optional multimodal image contexts (snake_case fields, aligned with backend ImageContextData). */
  imageContexts?: ImageInputContextData[];
}

export interface CompactSessionRequest {
  sessionId: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

 
export interface SessionInfo {
  sessionId: string;
  sessionName: string;
  agentType: string;
  state: string;
  turnCount: number;
  createdAt: number;
  status?: 'active' | 'archived' | 'completed';
}

export interface UpdateSessionModelRequest {
  sessionId: string;
  modelName: string;
}

export interface UpdateSessionTitleRequest {
  sessionId: string;
  title: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

 
export interface ModeInfo {
  id: string;
  name: string;
  description: string;
  isReadonly: boolean;
  toolCount: number;
  defaultTools?: string[];
  enabled: boolean;
}



export interface SubagentParentInfo {
  toolCallId: string;
  sessionId: string;
  dialogTurnId: string;
}

export interface AgenticEvent {
  sessionId: string;
  turnId?: string;
  subagentParentInfo?: SubagentParentInfo;
  [key: string]: any;
}

export interface TextChunkEvent extends AgenticEvent {
  roundId: string;
  text: string;
  contentType?: 'text' | 'thinking';
  isThinkingEnd?: boolean;
  subagentParentInfo?: SubagentParentInfo;
}

export interface ToolEvent extends AgenticEvent {
  toolEvent: any;
  subagentParentInfo?: SubagentParentInfo;
}

 
export interface ImageAnalysisEvent extends AgenticEvent {
  imageCount?: number;
  userInput?: string;
  success?: boolean;
  durationMs?: number;
}

export interface MemoryInjectedEvent {
  sessionId: string;
  count: number;
  displayPrompt?: string;
}

export interface WorkflowPhaseChangedEvent {
  sessionId: string;
  fromPhase: string;
  toPhase: string;
}

export interface PlanConfirmationNeededEvent {
  sessionId: string;
  planFilePath?: string;
}

export interface PlanConfirmationRespondedEvent {
  sessionId: string;
  confirmed: boolean;
}

export interface PlanAutoReviewStartedEvent {
  sessionId: string;
}

export interface PlanAutoReviewCompletedEvent {
  sessionId: string;
  summary?: string;
  issuesFound?: number;
  issuesResolved?: number;
}

export interface PlanReviseRequestedEvent {
  sessionId: string;
  feedback?: string;
}

export type AgentEvent = AgenticEvent;

export interface CompressionEvent extends AgenticEvent {
  compressionId: string;          
  
  trigger?: string;                // "auto" | "manual" | "user_message"
  tokensBefore?: number;           
  contextWindow?: number;          
  threshold?: number;              
  
  compressionCount?: number;       
  tokensAfter?: number;            
  compressionRatio?: number;       
  durationMs?: number;             
  hasSummary?: boolean;            
  summarySource?: 'model' | 'local_fallback' | 'none';
  
  error?: string;                  
  subagentParentInfo?: SubagentParentInfo;
}



export class AgentAPI {
  
  

  

   
  async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
    try {
      return await api.invoke<CreateSessionResponse>('create_session', { request });
    } catch (error) {
      throw createTauriCommandError('create_session', error, request);
    }
  }

  async cancelSessionCreation(creationId: string): Promise<void> {
    try {
      await api.invoke<void>('cancel_session_creation', { request: { creationId } });
    } catch (error) {
      throw createTauriCommandError('cancel_session_creation', error, { creationId });
    }
  }

   
  async startDialogTurn(request: StartDialogTurnRequest): Promise<{ success: boolean; message: string }> {
    try {
      return await api.invoke<{ success: boolean; message: string }>('start_dialog_turn', { request });
    } catch (error) {
      throw createTauriCommandError('start_dialog_turn', error, request);
    }
  }

  async compactSession(request: CompactSessionRequest): Promise<{ success: boolean; message: string }> {
    try {
      return await api.invoke<{ success: boolean; message: string }>('compact_session', { request });
    } catch (error) {
      throw createTauriCommandError('compact_session', error, request);
    }
  }

   
  async cancelDialogTurn(sessionId: string, dialogTurnId: string): Promise<void> {
    try {
      await api.invoke<void>('cancel_dialog_turn', { request: { sessionId, dialogTurnId } });
    } catch (error) {
      throw createTauriCommandError('cancel_dialog_turn', error, { sessionId, dialogTurnId });
    }
  }

   
  async deleteSession(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<void> {
    try {
      await api.invoke<void>('delete_session', { 
        request: { sessionId, workspacePath, remoteConnectionId, remoteSshHost } 
      });
    } catch (error) {
      throw createTauriCommandError('delete_session', error, { sessionId, workspacePath });
    }
  }

   
  async restoreSession(
    sessionId: string,
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<SessionInfo> {
    try {
      return await api.invoke<SessionInfo>('restore_session', {
        request: { sessionId, workspacePath, remoteConnectionId, remoteSshHost },
      });
    } catch (error) {
      throw createTauriCommandError('restore_session', error, { sessionId, workspacePath });
    }
  }

  /**
   * No-op if the session is already in the coordinator; otherwise loads it from disk
   * using the same workspace path resolution as restore_session (required for SSH remote workspaces).
   */
  async ensureCoordinatorSession(request: {
    sessionId: string;
    workspacePath: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  }): Promise<void> {
    try {
      await api.invoke<void>('ensure_coordinator_session', { request });
    } catch (error) {
      throw createTauriCommandError('ensure_coordinator_session', error, request);
    }
  }

  async updateSessionModel(request: UpdateSessionModelRequest): Promise<void> {
    try {
      await api.invoke<void>('update_session_model', { request });
    } catch (error) {
      throw createTauriCommandError('update_session_model', error, request);
    }
  }

  async updateSessionTitle(request: UpdateSessionTitleRequest): Promise<string> {
    try {
      return await api.invoke<string>('update_session_title', { request });
    } catch (error) {
      throw createTauriCommandError('update_session_title', error, request);
    }
  }


   
  async listSessions(
    workspacePath: string,
    remoteConnectionId?: string,
    remoteSshHost?: string
  ): Promise<SessionInfo[]> {
    try {
      return await api.invoke<SessionInfo[]>('list_sessions', {
        request: { workspacePath, remoteConnectionId, remoteSshHost },
      });
    } catch (error) {
      throw createTauriCommandError('list_sessions', error, { workspacePath });
    }
  }

  async confirmToolExecution(sessionId: string, toolId: string): Promise<void> {
    try {
      await api.invoke<void>('confirm_tool_execution', {
        request: {
          sessionId,
          toolId
        }
      });
    } catch (error) {
      throw createTauriCommandError('confirm_tool_execution', error, { sessionId, toolId });
    }
  }

   
  async rejectToolExecution(sessionId: string, toolId: string, reason?: string): Promise<void> {
    try {
      await api.invoke<void>('reject_tool_execution', {
        request: {
          sessionId,
          toolId,
          reason
        }
      });
    } catch (error) {
      throw createTauriCommandError('reject_tool_execution', error, { sessionId, toolId, reason });
    }
  }
  

   
  onSessionCreated(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://session-created', callback);
  }

  onSessionDeleted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://session-deleted', callback);
  }

  onSessionStateChanged(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://session-state-changed', callback);
  }

   
  onDialogTurnStarted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://dialog-turn-started', callback);
  }

   
  onModelRoundStarted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://model-round-started', callback);
  }

   
  onTextChunk(callback: (event: TextChunkEvent) => void): () => void {
    return api.listen<TextChunkEvent>('agent://text-chunk', callback);
  }

   
  onToolEvent(callback: (event: ToolEvent) => void): () => void {
    return api.listen<ToolEvent>('agent://tool-event', callback);
  }

   
  onDialogTurnCompleted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://dialog-turn-completed', callback);
  }

   
  onDialogTurnFailed(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://dialog-turn-failed', callback);
  }

   
  onDialogTurnCancelled(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://dialog-turn-cancelled', callback);
  }

   
  onTokenUsageUpdated(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://token-usage-updated', callback);
  }

   
  onContextCompressionStarted(callback: (event: CompressionEvent) => void): () => void {
    return api.listen<CompressionEvent>('agent://context-compression-started', callback);
  }

   
  onContextCompressionCompleted(callback: (event: CompressionEvent) => void): () => void {
    return api.listen<CompressionEvent>('agent://context-compression-completed', callback);
  }

   
  onContextCompressionFailed(callback: (event: CompressionEvent) => void): () => void {
    return api.listen<CompressionEvent>('agent://context-compression-failed', callback);
  }

  onImageAnalysisStarted(callback: (event: ImageAnalysisEvent) => void): () => void {
    return api.listen<ImageAnalysisEvent>('agent://image-analysis-started', callback);
  }

  onImageAnalysisCompleted(callback: (event: ImageAnalysisEvent) => void): () => void {
    return api.listen<ImageAnalysisEvent>('agent://image-analysis-completed', callback);
  }

  onMemoryInjected(callback: (event: MemoryInjectedEvent) => void): () => void {
    return api.listen<MemoryInjectedEvent>('agent://memory-injected', callback);
  }

  onWorkflowPhaseChanged(callback: (event: WorkflowPhaseChangedEvent) => void): () => void {
    return api.listen<WorkflowPhaseChangedEvent>('agent://workflow-phase-changed', callback);
  }

  onPlanConfirmationNeeded(callback: (event: PlanConfirmationNeededEvent) => void): () => void {
    return api.listen<PlanConfirmationNeededEvent>('agent://plan-confirmation-needed', callback);
  }

  onPlanConfirmationResponded(callback: (event: PlanConfirmationRespondedEvent) => void): () => void {
    return api.listen<PlanConfirmationRespondedEvent>('agent://plan-confirmation-responded', callback);
  }

  onPlanAutoReviewStarted(callback: (event: PlanAutoReviewStartedEvent) => void): () => void {
    return api.listen<PlanAutoReviewStartedEvent>('agent://plan-auto-review-started', callback);
  }

  onPlanAutoReviewCompleted(callback: (event: PlanAutoReviewCompletedEvent) => void): () => void {
    return api.listen<PlanAutoReviewCompletedEvent>('agent://plan-auto-review-completed', callback);
  }

  onPlanReviseRequested(callback: (event: PlanReviseRequestedEvent) => void): () => void {
    return api.listen<PlanReviseRequestedEvent>('agent://plan-revise-requested', callback);
  }

  onModelRoundCompleted(callback: (event: AgenticEvent) => void): () => void {
    return api.listen<AgenticEvent>('agent://model-round-completed', callback);
  }

  async confirmPlan(sessionId: string): Promise<void> {
    try {
      await api.invoke<void>('confirm_plan', { request: { sessionId } });
    } catch (error) {
      throw createTauriCommandError('confirm_plan', error, { sessionId });
    }
  }

  async rejectPlan(sessionId: string): Promise<void> {
    try {
      await api.invoke<void>('reject_plan', { request: { sessionId } });
    } catch (error) {
      throw createTauriCommandError('reject_plan', error, { sessionId });
    }
  }

  async revisePlan(sessionId: string, feedback: string): Promise<void> {
    try {
      await api.invoke<void>('revise_plan', { request: { sessionId, feedback } });
    } catch (error) {
      throw createTauriCommandError('revise_plan', error, { sessionId });
    }
  }

  async autoReviewPlan(sessionId: string): Promise<void> {
    try {
      await api.invoke<void>('auto_review_plan', { request: { sessionId } });
    } catch (error) {
      throw createTauriCommandError('auto_review_plan', error, { sessionId });
    }
  }

  async submitRating(
    sessionId: string,
    rating: {
      planRating: number;
      planFeedback: string;
      completeRating: number;
      completeFeedback: string;
    }
  ): Promise<{ success: boolean }> {
    try {
      return await api.invoke<{ success: boolean }>('submit_rating', {
        request: {
          sessionId,
          planRating: rating.planRating,
          planFeedback: rating.planFeedback,
          completeRating: rating.completeRating,
          completeFeedback: rating.completeFeedback,
        },
      });
    } catch (error) {
      throw createTauriCommandError('submit_rating', error, { sessionId });
    }
  }

  async archiveAndMerge(sessionId: string): Promise<{ success: boolean; merged: boolean; conflict: boolean; message: string }> {
    try {
      return await api.invoke<{ success: boolean; merged: boolean; conflict: boolean; message: string }>('archive_and_merge', { request: { sessionId } });
    } catch (error) {
      throw createTauriCommandError('archive_and_merge', error, { sessionId });
    }
  }

   
  async getAvailableTools(): Promise<string[]> {
    try {
      return await api.invoke<string[]>('get_available_tools');
    } catch (error) {
      throw createTauriCommandError('get_available_tools', error);
    }
  }

   
  async generateSessionTitle(
    sessionId: string,
    userMessage: string,
    maxLength?: number
  ): Promise<string> {
    try {
      return await api.invoke<string>('generate_session_title', {
        request: {
          sessionId,
          userMessage,
          maxLength: maxLength || 20
        }
      });
    } catch (error) {
      throw createTauriCommandError('generate_session_title', error, {
        sessionId,
        userMessage,
        maxLength
      });
    }
  }

   
  onSessionTitleGenerated(
    callback: (event: SessionTitleGeneratedEvent) => void
  ): () => void {
    return api.listen<SessionTitleGeneratedEvent>('session_title_generated', callback);
  }

  async cancelSession(sessionId: string): Promise<void> {
    try {
      await api.invoke<void>('cancel_session', {
        request: { sessionId }
      });
    } catch (error) {
      throw createTauriCommandError('cancel_session', error, { sessionId });
    }
  }

  async getAgentInfo(agentType: string): Promise<ModeInfo & { agent_type: string; when_to_use: string; tools: string; location: string }> {
    return {
      id: agentType,
      name: agentType,
      description: `${agentType} agent`,
      isReadonly: false,
      toolCount: 0,
      enabled: true,
      agent_type: agentType,
      when_to_use: `Use ${agentType} for related tasks`,
      tools: 'all',
      location: 'builtin',
    };
  }

  

   
  async getAvailableModes(): Promise<ModeInfo[]> {
    try {
      return await api.invoke<ModeInfo[]>('get_available_modes');
    } catch (error) {
      throw createTauriCommandError('get_available_modes', error);
    }
  }

}


export const agentAPI = new AgentAPI();

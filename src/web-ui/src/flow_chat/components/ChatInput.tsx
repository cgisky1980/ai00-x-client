/**
 * Standalone chat input component
 * Separated from bottom bar, supports session-level state awareness
 */

import React, { useRef, useCallback, useEffect, useReducer, useState, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ArrowUp, Image, CheckCircle, RotateCcw, Plus, X, Sparkles, Loader2, ChevronRight, Files } from 'lucide-react';
import { ContextDropZone, useContextStore } from '../../shared/context-system';
import { useActiveSessionState } from '../hooks/useActiveSessionState';
import { RichTextInput, type MentionState } from './RichTextInput';
import { FileMentionPicker } from './FileMentionPicker';
import { globalEventBus } from '../../infrastructure/event-bus';
import {
  useSessionDerivedState,
  useSessionStateMachine,
  useSessionStateMachineActions,
} from '../hooks/useSessionStateMachine';
import { SessionExecutionEvent } from '../state-machine/types';
import { ModelSelector } from './ModelSelector';
import { FlowChatStore } from '../store/FlowChatStore';
import { useActiveSession } from '../store/modernFlowChatStore';
import type { FlowChatState } from '../types/flow-chat';
import type { FileContext, DirectoryContext } from '../../shared/types/context';
import { SmartRecommendations } from './smart-recommendations';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { createImageContextFromFile, createImageContextFromClipboard } from '../utils/imageUtils';
import { notificationService } from '@/shared/notification-system';
import { inputReducer, initialInputState } from '../reducers/inputReducer';
import { modeReducer, initialModeState } from '../reducers/modeReducer';
import { CHAT_INPUT_CONFIG } from '../constants/chatInputConfig';
import { useMessageSender } from '../hooks/useMessageSender';
import { useChatInputState } from '../store/chatInputStateStore';
import { useInputHistoryStore } from '../store/inputHistoryStore';
import { FlowChatManager } from '../services/FlowChatManager';
import { createLogger } from '@/shared/utils/logger';
import { Tooltip, IconButton } from '@/component-library';
import { StarRating } from '@/component-library';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { useSceneStore } from '@/app/stores/sceneStore';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import type { SkillInfo } from '@/infrastructure/config/types';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { fetchAi00sModels, getCachedAi00sModels, isAi00sModel } from '@/infrastructure/config/services/ai00sTier';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import MCPAPI, { type MCPPrompt, type MCPPromptMessage, type MCPServerInfo } from '@/infrastructure/api/service-api/MCPAPI';
import { deriveChatInputPetMood } from '../utils/chatInputPetMood';
import { ChatInputPixelPet } from './ChatInputPixelPet';
import './ChatInput.scss';

const log = createLogger('ChatInput');
const IME_ENTER_GUARD_MS = 120;

export interface ChatInputProps {
  className?: string;
  onSendMessage?: (message: string) => void;
}

type SlashSkillItem = {
  kind: 'skill';
  id: string;
  name: string;
  description: string;
};

type SlashModeItem = {
  kind: 'mode';
  id: string;
  name: string;
};

type SlashMcpPromptItem = {
  kind: 'mcpPrompt';
  id: string;
  command: string;
  label: string;
  serverId: string;
  serverName: string;
  promptName: string;
  description?: string;
  arguments: Array<{
    name: string;
    required: boolean;
    description?: string;
  }>;
};

type SlashPickerItem = SlashSkillItem | SlashModeItem | SlashMcpPromptItem;
type PendingLargePasteMap = Record<string, string>;

function getCharacterCount(text: string): number {
  return Array.from(text).length;
}

function buildMcpPromptSlashCommand(serverId: string, promptName: string): string {
  return `/${serverId}:${promptName}`;
}

function parseSlashArguments(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) || [];
  return matches.map(token => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith('\'') && token.endsWith('\''))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function renderMcpPromptContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content || typeof content !== 'object') {
    return '[Unsupported MCP prompt content]';
  }

  const block = content as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : undefined;

  if (type === 'text' && typeof block.text === 'string') {
    return block.text;
  }

  if (type === 'image') {
    return `[Image${typeof block.mimeType === 'string' ? `: ${block.mimeType}` : ''}]`;
  }

  if (type === 'audio') {
    return `[Audio${typeof block.mimeType === 'string' ? `: ${block.mimeType}` : ''}]`;
  }

  if (type === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : 'unknown';
    const name = typeof block.name === 'string' ? block.name : undefined;
    return name ? `[Resource Link: ${name} (${uri})]` : `[Resource Link: ${uri}]`;
  }

  if (type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>;
    const resourceText =
      typeof resource.text === 'string'
        ? resource.text
        : typeof resource.content === 'string'
          ? resource.content
          : undefined;
    if (resourceText) {
      return resourceText;
    }
    const uri = typeof resource.uri === 'string' ? resource.uri : 'unknown';
    return `[Resource: ${uri}]`;
  }

  return '[Unsupported MCP prompt content]';
}

function renderMcpPromptMessages(messages: MCPPromptMessage[]): string {
  return messages
    .map(message => {
      const text = renderMcpPromptContent(message.content).trim();
      if (!text) {
        return '';
      }

      switch (message.role) {
        case 'system':
          return text;
        case 'user':
          return `User: ${text}`;
        case 'assistant':
          return `Assistant: ${text}`;
        default:
          return `${message.role}: ${text}`;
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

export const ChatInput: React.FC<ChatInputProps> = ({
  className = '',
  onSendMessage
}) => {
  const { t } = useTranslation('flow-chat');
  
  const [inputState, dispatchInput] = useReducer(inputReducer, initialInputState);
  const [modeState, dispatchMode] = useReducer(modeReducer, initialModeState);
  
  const richTextInputRef = useRef<HTMLDivElement>(null);
  const agentBoostRef = useRef<HTMLDivElement>(null);
  const isImeComposingRef = useRef(false);
  const lastImeCompositionEndAtRef = useRef(0);
  // Ref so the queuedInput sync effect can read the latest value without it being a dep
  const inputValueRef = useRef('');
  const pendingLargePastesRef = useRef<PendingLargePasteMap>({});
  const largePasteCountersRef = useRef<Record<number, number>>({});
  
  // History navigation state
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const { addMessage: addToHistory, getSessionHistory } = useInputHistoryStore();

  const contexts = useContextStore(state => state.contexts);
  const addContext = useContextStore(state => state.addContext);
  const removeContext = useContextStore(state => state.removeContext);
  const clearContexts = useContextStore(state => state.clearContexts);

  const currentImageCount = useMemo(
    () => contexts.filter(c => c.type === 'image').length,
    [contexts],
  );

  const activeSessionState = useActiveSessionState();
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => FlowChatStore.getInstance().getState());
  const currentSessionId = activeSessionState.sessionId;
  const currentSession = currentSessionId ? flowChatState.sessions.get(currentSessionId) : undefined;
  const activeModernSession = useActiveSession();
  const taskCompleted = activeModernSession?.taskCompleted ?? false;
  const taskSessionId = activeModernSession?.sessionId ?? '';
  const planFilePath = activeModernSession?.planFilePath;
  const isArchived = activeModernSession?.completionPhase === 'archived';
  const showRatingCard = !isArchived && taskCompleted && currentSession?.mode !== 'Wallpaper';

  // Memoize history so keyboard handlers don't see a fresh [] on every render.
  const inputHistory = useMemo(
    () => (currentSessionId ? getSessionHistory(currentSessionId) : []),
    [currentSessionId, getSessionHistory],
  );
  const derivedState = useSessionDerivedState(
    currentSessionId,
    inputState.value.trim()
  );
  const sessionMachineSnapshot = useSessionStateMachine(currentSessionId);
  const petMood = useMemo(
    () => deriveChatInputPetMood(sessionMachineSnapshot),
    [sessionMachineSnapshot],
  );
  const [agentCompanionEnabled, setAgentCompanionEnabled] = useState(
    () => aiExperienceConfigService.getSettings().enable_agent_companion,
  );
  useEffect(() => {
    setAgentCompanionEnabled(aiExperienceConfigService.getSettings().enable_agent_companion);
    return aiExperienceConfigService.addChangeListener(settings => {
      setAgentCompanionEnabled(settings.enable_agent_companion);
    });
  }, []);
  const showCollapsedPet =
    agentCompanionEnabled && !inputState.isActive && !inputState.value.trim();
  const { transition, setQueuedInput } = useSessionStateMachineActions(currentSessionId);

  const { workspace: _workspace, workspacePath } = useCurrentWorkspace();
  
  const [tokenUsage, setTokenUsage] = React.useState({ current: 0, max: 128128 });
  const currentMode = modeState.current;
  const canSwitchModes = true;

  // Determine whether the current model supports image input (LMM/multimodal).
  const [isMultimodalModel, setIsMultimodalModel] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const checkModelCapabilities = async () => {
      try {
        const [models, defaultModelsData, agentModelsData] = await Promise.all([
          configManager.getConfig<AIModelConfig[]>('ai.models') || [],
          configManager.getConfig<Record<string, string>>('ai.default_models') || {},
          configManager.getConfig<Record<string, string>>('ai.agent_models') || {},
        ]);
        if (cancelled) return;
        const configuredModelId = agentModelsData[currentMode] || 'auto';
        let model: AIModelConfig | undefined;
        if (configuredModelId === 'auto') {
          model = models.find(m => m.id === defaultModelsData.primary);
        } else {
          model = models.find(m => m.id === configuredModelId);
        }
        // Default to false (block images) if model info is unavailable.
        let result = false;
        if (model) {
          if (isAi00sModel(model.id || '')) {
            // For ai00s models, check the selected sub-model's modality (LLM/LMM)
            const xfModels = getCachedAi00sModels() || await fetchAi00sModels().catch(() => []);
            const xfModel = xfModels.find(m => m.id === model!.model_name);
            result = xfModel?.modality?.toUpperCase() === 'LMM';
          } else {
            // For local models, check the category field
            result = model.category === 'multimodal';
          }
        }
        console.log('[MultimodalCheck]', {
          currentMode,
          configuredModelId,
          modelId: model?.id,
          modelName: model?.model_name,
          category: model?.category,
          isAi00s: model ? isAi00sModel(model.id || '') : false,
          isMultimodal: result,
        });
        setIsMultimodalModel(result);
      } catch (err) {
        console.log('[MultimodalCheck] ERROR:', err);
        if (!cancelled) setIsMultimodalModel(false);
      }
    };
    checkModelCapabilities();
    const unsubscribe = configManager.onConfigChange(() => { checkModelCapabilities(); });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentMode]);

  const TOP_LEVEL_AGENT_IDS = new Set(['Code', 'Task', 'Wallpaper']);

  const getDefaultTopLevelAgent = useCallback((): string => {
    const sessionMode = currentSession?.mode || '';
    const normalized = sessionMode.toLowerCase();
    if (normalized === 'task') return 'Task';
    if (normalized === 'wall' || normalized === 'wallpaper') return 'Wallpaper';
    return 'Code';
  }, [currentSession?.mode]);

  const switchableModes = useMemo(
    () =>
      modeState.available.filter(mode =>
        mode.enabled
      ),
    [modeState.available]
  );

  const openScene = useSceneStore(s => s.openScene);
  const [boostPanelSkills, setBoostPanelSkills] = useState<SkillInfo[]>([]);
  const [boostSkillsLoading, setBoostSkillsLoading] = useState(false);

  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([]);

  const [skillsFlyoutOpen, setSkillsFlyoutOpen] = useState(false);
  const [skillsFlyoutLeft, setSkillsFlyoutLeft] = useState(false);
  const [skillsFlyoutUp, setSkillsFlyoutUp] = useState(false);
  const skillsHostRef = useRef<HTMLDivElement>(null);
  const skillsTimerRef = useRef<number | null>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const modesListRef = useRef<HTMLDivElement>(null);

  const [badgeMode, setBadgeMode] = useState<'rating' | 'chat'>('rating');
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const [ratingDone, setRatingDone] = useState(false);

  const clearSkillsTimer = useCallback(() => {
    if (skillsTimerRef.current !== null) {
      window.clearTimeout(skillsTimerRef.current);
      skillsTimerRef.current = null;
    }
  }, []);

  const openSkillsFlyout = useCallback(() => {
    clearSkillsTimer();
    const host = skillsHostRef.current;
    if (host) {
      const r = host.getBoundingClientRect();
      setSkillsFlyoutLeft(r.right + 260 > window.innerWidth - 8);
      setSkillsFlyoutUp(r.top + 200 > window.innerHeight - 8);
    }
    setSkillsFlyoutOpen(true);
  }, [clearSkillsTimer]);

  const closeSkillsFlyout = useCallback(() => {
    clearSkillsTimer();
    skillsTimerRef.current = window.setTimeout(() => {
      skillsTimerRef.current = null;
      setSkillsFlyoutOpen(false);
    }, 150);
  }, [clearSkillsTimer]);
  
  const setChatInputActive = useChatInputState(state => state.setActive);
  const setChatInputExpanded = useChatInputState(state => state.setExpanded);
  const setChatInputHeight = useChatInputState(state => state.setInputHeight);

  useEffect(() => {
    const unsubscribe = FlowChatStore.getInstance().subscribe(setFlowChatState);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setChatInputActive(inputState.isActive);
  }, [inputState.isActive, setChatInputActive]);
  
  useEffect(() => {
    setChatInputExpanded(inputState.isExpanded);
  }, [inputState.isExpanded, setChatInputExpanded]);
  
  // Reset history index when switching sessions
  useEffect(() => {
    setHistoryIndex(-1);
  }, [currentSessionId]);
  
  const { sendMessage } = useMessageSender({
    currentSessionId: currentSessionId || undefined,
    contexts,
    onClearContexts: clearContexts,
    onSuccess: onSendMessage,
    // Composer mode is authoritative (synced from session on switch, updated in
    // applyModeChange). Prefer it over session.mode so a stale store cannot force
    // Core when the user selected another mode.
    currentAgentType: modeState.current,
  });

  const [mcpPromptCommands, setMcpPromptCommands] = useState<SlashMcpPromptItem[]>([]);
  const [mcpPromptCommandsLoading, setMcpPromptCommandsLoading] = useState(false);

  const loadMcpPromptCommands = useCallback(async () => {
    setMcpPromptCommandsLoading(true);

    try {
      const servers = await MCPAPI.getServers();
      const connectedServers = servers.filter(
        server => server.status === 'Connected' || server.status === 'Healthy'
      );

      const promptGroups = await Promise.all(
        connectedServers.map(async (server: MCPServerInfo) => {
          try {
            const prompts = await MCPAPI.listPrompts({
              serverId: server.id,
              refresh: true,
            });
            return prompts.map((prompt: MCPPrompt) => ({
              kind: 'mcpPrompt' as const,
              id: `${server.id}:${prompt.name}`,
              command: buildMcpPromptSlashCommand(server.id, prompt.name),
              label:
                prompt.description?.trim() ||
                `${server.name} MCP prompt`,
              serverId: server.id,
              serverName: server.name,
              promptName: prompt.name,
              description: prompt.description,
              arguments: (prompt.arguments || []).map(argument => ({
                name: argument.name,
                required: argument.required,
                description: argument.description,
              })),
            }));
          } catch (error) {
            log.warn('Failed to load MCP prompts for server', {
              serverId: server.id,
              error,
            });
            return [] as SlashMcpPromptItem[];
          }
        })
      );

      setMcpPromptCommands(
        promptGroups
          .flat()
          .sort((a, b) => a.command.localeCompare(b.command))
      );
    } finally {
      setMcpPromptCommandsLoading(false);
    }
  }, []);
  
  const [recommendationContext, setRecommendationContext] = React.useState<{
    workspacePath?: string;
    sessionId?: string;
    turnIndex?: number;
    modifiedFiles?: string[];
  } | null>(null);
  
  const [mentionState, setMentionState] = useState<MentionState>({
    isActive: false,
    query: '',
    startOffset: 0,
  });
  
  const [slashCommandState, setSlashCommandState] = useState<{
    isActive: boolean;
    kind: 'modes' | 'all';
    query: string;
    selectedIndex: number;
  }>({
    isActive: false,
    kind: 'modes',
    query: '',
    selectedIndex: 0,
  });

  const clearPendingLargePastes = useCallback(() => {
    pendingLargePastesRef.current = {};
  }, []);

  const createLargePastePlaceholder = useCallback((text: string): string | null => {
    const charCount = getCharacterCount(text);
    if (charCount <= CHAT_INPUT_CONFIG.largePaste.thresholdChars) {
      return null;
    }

    const nextCounters = largePasteCountersRef.current;
    const nextSuffix = (nextCounters[charCount] ?? 0) + 1;
    nextCounters[charCount] = nextSuffix;

    const base = t('input.largePastePlaceholder', {
      count: charCount,
      defaultValue: '[Pasted Content {{count}} chars]',
    });
    const placeholder = nextSuffix === 1 ? base : `${base} #${nextSuffix}`;

    pendingLargePastesRef.current = {
      ...pendingLargePastesRef.current,
      [placeholder]: text,
    };

    return placeholder;
  }, [t]);

  const prunePendingLargePastes = useCallback((text: string) => {
    const entries = Object.entries(pendingLargePastesRef.current);
    if (entries.length === 0) {
      return;
    }

    pendingLargePastesRef.current = Object.fromEntries(
      entries.filter(([placeholder]) => text.includes(placeholder))
    );
  }, []);

  const expandPendingLargePastes = useCallback((text: string) => {
    let expanded = text;
    for (const [placeholder, actual] of Object.entries(pendingLargePastesRef.current)) {
      if (expanded.includes(placeholder)) {
        expanded = expanded.split(placeholder).join(actual);
      }
    }
    return expanded;
  }, []);

  React.useEffect(() => {
    if (inputState.value === '') {
      clearPendingLargePastes();
    }
  }, [clearPendingLargePastes, inputState.value]);
  
  React.useEffect(() => {
    const store = FlowChatStore.getInstance();
    
    const unsubscribe = store.subscribe((state: FlowChatState) => {
      if (currentSessionId) {
        const session = state.sessions.get(currentSessionId);
        if (session) {
          setTokenUsage({
            current: session.currentTokenUsage?.totalTokens || 0,
            max: session.maxContextTokens || 128128
          });
        }
      }
    });

    if (currentSessionId) {
      const state = store.getState();
      const session = state.sessions.get(currentSessionId);
      if (session) {
        setTokenUsage({
          current: session.currentTokenUsage?.totalTokens || 0,
          max: session.maxContextTokens || 128128
        });
      }
    }

    return () => unsubscribe();
  }, [currentSessionId]);

  React.useEffect(() => {
    const handleFillInput = (event: Event) => {
      const customEvent = event as CustomEvent<{ message: string }>;
      const message = customEvent.detail?.message;
      
      if (message) {
        clearPendingLargePastes();
        dispatchInput({ type: 'ACTIVATE' });
        dispatchInput({ type: 'SET_VALUE', payload: message });
        
        if (richTextInputRef.current) {
          richTextInputRef.current.focus();
        }
      }
    };

    window.addEventListener('fill-chat-input', handleFillInput);
    
    return () => {
      window.removeEventListener('fill-chat-input', handleFillInput);
    };
  }, [clearPendingLargePastes]);

  React.useEffect(() => {
    const handleFillChatInput = (data: { content: string }) => {
      clearPendingLargePastes();
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: data.content });

      if (richTextInputRef.current) {
        richTextInputRef.current.focus();
      }
    };

    globalEventBus.on('fill-chat-input', handleFillChatInput);

    return () => {
      globalEventBus.off('fill-chat-input', handleFillChatInput);
    };
  }, [clearPendingLargePastes]);

  React.useEffect(() => {
    if (!slashCommandState.isActive || slashCommandState.kind !== 'all' || derivedState?.isProcessing) {
      return;
    }

    void loadMcpPromptCommands();
  }, [derivedState?.isProcessing, loadMcpPromptCommands, slashCommandState.isActive, slashCommandState.kind]);

  // Handle MCP App ui/message requests (aligned with VSCode behavior)
  React.useEffect(() => {
    const handleMcpAppMessage = async (event: import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageEvent) => {
      const { requestId, params } = event;

      // Don't fill if input already has content (aligned with VSCode behavior)
      if (inputState.value.trim()) {
        log.warn('MCP App ui/message rejected: input already has content');
        // Send error response (VSCode returns { isError: true } in this case)
        globalEventBus.emit('mcp-app:message-response', {
          requestId,
          result: { isError: true }
        } as import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageResponseEvent);
        return;
      }

      try {
        // Extract text content and set input
        const textContent = params.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n\n');

        if (textContent) {
          clearPendingLargePastes();
          dispatchInput({ type: 'ACTIVATE' });
          dispatchInput({ type: 'SET_VALUE', payload: textContent });
        }

        // Handle image attachments (respect max image limit and multimodal capability)
        if (!isMultimodalModel) {
          // Skip image blocks for text-only models
        } else {
        let imgCount = currentImageCount;
        for (const block of params.content) {
          if (block.type === 'image') {
            if (imgCount >= CHAT_INPUT_CONFIG.image.maxCount) break;
            try {
              const mimeType = block.mimeType || 'image/png';
              const binaryString = atob(block.data);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: mimeType });
              const file = new File([blob], `image.${mimeType.split('/')[1] || 'png'}`, { type: mimeType });
              const imageContext = await createImageContextFromClipboard(file);
              addContext(imageContext);
              imgCount++;
            } catch (err) {
              log.error('Failed to add image from MCP App message', { err });
            }
          }
        }
        }

        // Focus input
        if (richTextInputRef.current) {
          richTextInputRef.current.focus();
        }

        // Send success response
        globalEventBus.emit('mcp-app:message-response', {
          requestId,
          result: { isError: false }
        } as import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageResponseEvent);
      } catch (err) {
        log.error('Failed to handle MCP App ui/message', { err });
        // Send error response
        globalEventBus.emit('mcp-app:message-response', {
          requestId,
          result: { isError: true }
        } as import('@/infrastructure/api/service-api/MCPAPI').McpAppMessageResponseEvent);
      }
    };

    globalEventBus.on('mcp-app:message', handleMcpAppMessage);

    return () => {
      globalEventBus.off('mcp-app:message', handleMcpAppMessage);
    };
  }, [inputState.value, addContext, clearPendingLargePastes, currentImageCount, isMultimodalModel]);

  React.useEffect(() => {
    const handleInsertContextTag = (event: Event) => {
      const customEvent = event as CustomEvent<{ context: any }>;
      const context = customEvent.detail?.context;
      
      if (context) {
        if (!inputState.isActive) {
          dispatchInput({ type: 'ACTIVATE' });
        }

        setTimeout(() => {
          if (richTextInputRef.current && (richTextInputRef.current as any).insertTag) {
            const el = richTextInputRef.current;
            if (!el.textContent?.trim() && !el.querySelector('[data-context-id]')) {
              el.innerHTML = '';
            }
            el.focus();
            const sel = window.getSelection();
            if (sel) {
              sel.selectAllChildren(el);
              sel.collapseToEnd();
            }
            (el as any).insertTag(context);
          }
        }, 50);
      }
    };

    window.addEventListener('insert-context-tag', handleInsertContextTag);
    
    return () => {
      window.removeEventListener('insert-context-tag', handleInsertContextTag);
    };
  }, [inputState.isActive]);

  React.useEffect(() => {
    const fetchAvailableModes = async () => {
      try {
        const { agentAPI } = await import('@/infrastructure/api/service-api/AgentAPI');
        const modes = await agentAPI.getAvailableModes();
        dispatchMode({ type: 'SET_AVAILABLE_MODES', payload: modes });
      } catch (error) {
        log.error('Failed to fetch available modes', { error });
      }
    };
    
    fetchAvailableModes();
    
    const handleModeConfigUpdated = () => {
      fetchAvailableModes();
    };
    
    globalEventBus.on('mode:config:updated', handleModeConfigUpdated);
    
    return () => {
      globalEventBus.off('mode:config:updated', handleModeConfigUpdated);
    };
  }, []);

  React.useEffect(() => {
    const handleSessionSwitched = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string; mode: string }>;
      const { sessionId, mode } = customEvent.detail || {};
      
      if (sessionId && mode) {
        log.debug('Session switched, syncing mode', { sessionId, mode });
        dispatchMode({ type: 'SET_CURRENT_MODE', payload: mode });
        try {
          sessionStorage.setItem('ai00-x:flowchat:lastMode', mode);
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener('ai00-x:session-switched', handleSessionSwitched);
    
    return () => {
      window.removeEventListener('ai00-x:session-switched', handleSessionSwitched);
    };
  }, []);

  React.useEffect(() => {
    if (!currentSessionId) return;
    
    const store = FlowChatStore.getInstance();
    const state = store.getState();
    const session = state.sessions.get(currentSessionId);
    
    if (session?.mode) {
      log.debug('Session ID changed, syncing mode', { sessionId: currentSessionId, mode: session.mode });
      dispatchMode({ type: 'SET_CURRENT_MODE', payload: session.mode });
      try {
        sessionStorage.setItem('ai00-x:flowchat:lastMode', session.mode);
      } catch {
        // ignore
      }
    }
  }, [currentSessionId]);

  React.useEffect(() => {
    const queuedInput = derivedState?.queuedInput;
    if (!queuedInput?.trim() || !currentSessionId) {
      return;
    }
    // Sync machine queue into the input (e.g. failed turn restored by EventHandlerModule).
    // `queuedInput` is cleared on successful send via `setQueuedInput(null)` so we do not fight CLEAR_VALUE.
    // Use inputValueRef (not inputState.value) so this effect only re-runs when the machine's
    // queuedInput actually changes — not on every keystroke — avoiding the race condition where
    // a stale queuedInput would overwrite what the user is currently typing.
    const currentValue = inputValueRef.current;
    if (currentValue !== queuedInput && !currentValue.trim()) {
      // Only restore when the input is empty: this effect is for failure-recovery
      // (EventHandlerModule sets queuedInput on failed turns), NOT for live typing.
      // Restoring while the user is actively typing would overwrite their draft.
      log.debug('Detected queuedInput, restoring message to input', { queuedInput });
      clearPendingLargePastes();
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: queuedInput });
      inputValueRef.current = queuedInput;
      if (richTextInputRef.current) {
        richTextInputRef.current.focus();
      }
    }
  }, [
    derivedState?.queuedInput,
    currentSessionId,
    clearPendingLargePastes,
  ]);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (agentBoostRef.current && !agentBoostRef.current.contains(event.target as Node)) {
        dispatchMode({ type: 'CLOSE_DROPDOWN' });
      }
    };

    if (modeState.dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [modeState.dropdownOpen]);

  useEffect(() => {
    if (!modeState.dropdownOpen) {
      return;
    }
    let cancelled = false;
    setBoostSkillsLoading(true);
    (async () => {
      try {
        const { configAPI } = await import('@/infrastructure/api');
        const list = await configAPI.getSkillConfigs({
          workspacePath: workspacePath || undefined,
        });
        if (!cancelled) {
          setBoostPanelSkills(list);
        }
      } catch (err) {
        log.error('Failed to load skills for boost panel', { err });
        if (!cancelled) setBoostPanelSkills([]);
      } finally {
        if (!cancelled) setBoostSkillsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modeState.dropdownOpen, workspacePath]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { configAPI } = await import('@/infrastructure/api');
        const list = await configAPI.getSkillConfigs({
          workspacePath: workspacePath || undefined,
        });
        if (!cancelled) {
          setSlashSkills(list);
        }
      } catch (err) {
        log.error('Failed to load skills for slash picker', { err });
        if (!cancelled) setSlashSkills([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  useEffect(() => {
    if (!slashCommandState.isActive) return;
    const list = slashListRef.current || modesListRef.current;
    if (!list) return;
    const selected = list.querySelector('.ai00-x-chat-input__slash-command-item--selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [slashCommandState.selectedIndex, slashCommandState.isActive]);

  useEffect(() => {
    if (!modeState.dropdownOpen) {
      clearSkillsTimer();
      setSkillsFlyoutOpen(false);
    }
  }, [clearSkillsTimer, modeState.dropdownOpen]);

  useEffect(
    () => () => {
      clearSkillsTimer();
    },
    [clearSkillsTimer]
  );

  useEffect(() => {
    const handleImagePaste = async (event: Event) => {
      const customEvent = event as CustomEvent<{ file: File }>;
      const file = customEvent.detail?.file;

      if (!file) return;

      if (!isMultimodalModel) {
        notificationService.warning(t('input.imageNotSupported'), { duration: 3000 });
        return;
      }

      if (currentImageCount >= CHAT_INPUT_CONFIG.image.maxCount) {
        notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
        return;
      }
      
      try {
        const imageContext = await createImageContextFromClipboard(file);
        
        addContext(imageContext);
        
        if (richTextInputRef.current && (richTextInputRef.current as any).insertTag) {
          (richTextInputRef.current as any).insertTag(imageContext);
        }
        
        notificationService.success(
          t('input.imageAddedSingle', { name: imageContext.imageName }),
          { duration: 2000 }
        );
      } catch (error) {
        log.error('Failed to process clipboard image', { fileName: file.name, error });
        notificationService.error(
          `${t('input.imagePasteFailed')}: ${error instanceof Error ? error.message : t('error.unknown')}`,
          { duration: 3000 }
        );
      }
    };
    
    const inputElement = richTextInputRef.current;
    if (inputElement) {
      inputElement.addEventListener('imagePaste', handleImagePaste);
    }
    
    return () => {
      if (inputElement) {
        inputElement.removeEventListener('imagePaste', handleImagePaste);
      }
    };
  }, [addContext, currentImageCount, isMultimodalModel, t]);

  React.useEffect(() => {
    if (!currentSessionId || !workspacePath) {
      return;
    }

    const store = FlowChatStore.getInstance();
    const state = store.getState();
    const session = state.sessions.get(currentSessionId);

    if (!session || session.dialogTurns.length === 0) {
      return;
    }

    const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
    
    if (lastTurn.status === 'completed') {
      const modifiedFiles: string[] = [];
      
      for (const round of lastTurn.modelRounds) {
        for (const item of round.items) {
          if (item.type === 'tool') {
            const toolItem = item as import('../types/flow-chat').FlowToolItem;
            const fileModifyTools = ['write_file', 'edit_file', 'create_file', 'delete_file'];
            if (fileModifyTools.includes(toolItem.toolName)) {
              const toolInput = toolItem.toolCall?.input;
              if (toolInput && typeof toolInput === 'object') {
                const filePath = (toolInput as any).file_path || (toolInput as any).path || (toolInput as any).filePath;
                if (filePath && typeof filePath === 'string') {
                  modifiedFiles.push(filePath);
                }
              }
            }
          }
        }
      }

      if (modifiedFiles.length > 0) {
        log.debug('File modifications detected, updating recommendation context', { modifiedFiles });
        setRecommendationContext({
          workspacePath,
          sessionId: currentSessionId,
          turnIndex: session.dialogTurns.length - 1,
          modifiedFiles: [...new Set(modifiedFiles)]
        });
      }
    }
  }, [currentSessionId, workspacePath, derivedState?.isProcessing]);

  const getFilteredSkills = useCallback((): SlashSkillItem[] => {
    const items: SlashSkillItem[] = slashSkills.map(skill => ({
      kind: 'skill',
      id: skill.key,
      name: skill.name,
      description: skill.description,
    }));

    const q = (slashCommandState.query || '').trim().toLowerCase();
    if (!q) return items;

    return items.filter(i => {
      return i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q);
    });
  }, [slashSkills, slashCommandState.query]);

  const getFilteredMcpPromptCommands = useCallback((): SlashMcpPromptItem[] => {
    const q = (slashCommandState.query || '').trim().toLowerCase();
    if (!q) {
      return mcpPromptCommands;
    }

    return mcpPromptCommands.filter(item => {
      const commandToken = item.command.slice(1).toLowerCase();
      return (
        commandToken.includes(q) ||
        item.serverName.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q)
      );
    });
  }, [mcpPromptCommands, slashCommandState.query]);

  const resolveTypedMcpPromptCommand = useCallback((text: string): SlashMcpPromptItem | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return null;
    }

    const token = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() || '';
    if (!token) {
      return null;
    }

    return (
      mcpPromptCommands.find(item => item.command.slice(1).toLowerCase() === token) || null
    );
  }, [mcpPromptCommands]);

  const getSlashPickerItems = useCallback((): SlashPickerItem[] => {
    const skills = getFilteredSkills();
    const mcpPrompts = getFilteredMcpPromptCommands();
    let modeList = switchableModes;
    if (canSwitchModes && slashCommandState.query) {
      const q = slashCommandState.query;
      modeList = switchableModes.filter(
        mode =>
          mode.name.toLowerCase().includes(q) ||
          mode.id.toLowerCase().includes(q)
      );
    }
    const modes: SlashModeItem[] = (canSwitchModes ? modeList : []).map(mode => ({
      kind: 'mode',
      id: mode.id,
      name: mode.name,
    }));
    return [...skills, ...mcpPrompts, ...modes];
  }, [canSwitchModes, getFilteredSkills, getFilteredMcpPromptCommands, switchableModes, slashCommandState.query]);
  
  const handleInputChange = useCallback((text: string, activeContexts: import('../../shared/types/context').ContextItem[]) => {
    if (!inputState.isActive && text.length > 0) {
      dispatchInput({ type: 'ACTIVATE' });
    }

    const activeContextIds = new Set(activeContexts.map(context => context.id));
    contexts.forEach(context => {
      if (!activeContextIds.has(context.id)) {
        removeContext(context.id);
      }
    });
    
    prunePendingLargePastes(text);
    dispatchInput({ type: 'SET_VALUE', payload: text });
    inputValueRef.current = text;

    const trimmedLower = text.trim().toLowerCase();
    const isCompactCommand = trimmedLower.startsWith('/compact');

    // Don't queue /compact while the main session is processing.
    if (derivedState?.isProcessing && !isCompactCommand) {
      setQueuedInput(text);
    }

    if (text.startsWith('/')) {
      const afterSlash = text.slice(1);
      const firstToken = afterSlash.trimStart().split(/\s+/, 1)[0]?.toLowerCase?.() ?? '';
      const query = firstToken;
      const matchedMcpPrompt = resolveTypedMcpPromptCommand(text);

      if (!isCompactCommand && !matchedMcpPrompt) {
        setSlashCommandState({
          isActive: true,
          kind: 'all',
          query,
          selectedIndex: 0,
        });
        return;
      }
    }

    if (slashCommandState.isActive) {
      setSlashCommandState({
        isActive: false,
        kind: 'modes',
        query: '',
        selectedIndex: 0,
      });
    }
  }, [contexts, derivedState, inputState.isActive, prunePendingLargePastes, removeContext, resolveTypedMcpPromptCommand, setQueuedInput, slashCommandState.isActive]);

  const submitCompactFromInput = useCallback(async () => {
    if (!currentSessionId || !currentSession) {
      notificationService.error(
        t('chatInput.compactNoSession', { defaultValue: 'No active session for /compact' })
      );
      return;
    }

    if (derivedState?.isProcessing) {
      notificationService.warning(
        t('chatInput.compactBusy', {
          defaultValue: 'Wait until the session is idle before using /compact.',
        })
      );
      return;
    }

    const message = inputState.value.trim();
    if (!/^\/compact\s*$/i.test(message)) {
      notificationService.warning(
        t('chatInput.compactUsage', { defaultValue: 'Use /compact without extra arguments.' })
      );
      return;
    }

    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'modes', query: '', selectedIndex: 0 });

    try {
      const { agentAPI } = await import('@/infrastructure/api');
      await agentAPI.compactSession({
        sessionId: currentSessionId,
        workspacePath: currentSession.workspacePath,
        remoteConnectionId: currentSession.remoteConnectionId,
        remoteSshHost: currentSession.remoteSshHost,
      });
    } catch (error) {
      log.error('Failed to trigger /compact', {
        error,
        sessionId: currentSessionId,
      });
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: message });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.compactFailed', { defaultValue: 'Session compaction failed' }),
          duration: 5000,
        }
      );
    }
  }, [
    derivedState?.isProcessing,
    currentSession,
    currentSessionId,
    inputState.value,
    setQueuedInput,
    t,
  ]);

  const submitInitFromInput = useCallback(async () => {
    if (!currentSessionId || !currentSession) {
      notificationService.error(
        t('chatInput.initNoSession', { defaultValue: 'No active session for /init' })
      );
      return;
    }

    if (derivedState?.isProcessing) {
      notificationService.warning(
        t('chatInput.initBusy', {
          defaultValue: 'Wait until the session is idle before using /init.',
        })
      );
      return;
    }

    const message = inputState.value.trim();
    if (!/^\/init\s*$/i.test(message)) {
      notificationService.warning(
        t('chatInput.initUsage', { defaultValue: 'Use /init without extra arguments.' })
      );
      return;
    }

    const initInstruction = t('chatInput.initPrompt', {
      defaultValue: 'Please generate or update AGENTS.md so it matches the current project. Write it in English and keep the English version complete.',
    });

    dispatchInput({ type: 'CLEAR_VALUE' });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'modes', query: '', selectedIndex: 0 });

    try {
      const flowChatManager = FlowChatManager.getInstance();
      await flowChatManager.sendMessage(
        initInstruction,
        currentSessionId,
        initInstruction,
        'Init'
      );
      onSendMessage?.(initInstruction);
      dispatchInput({ type: 'DEACTIVATE' });
    } catch (error) {
      log.error('Failed to trigger /init', {
        error,
        sessionId: currentSessionId,
      });
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: message });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.initFailed', { defaultValue: 'Session init failed' }),
          duration: 5000,
        }
      );
    }
  }, [
    derivedState?.isProcessing,
    currentSession,
    currentSessionId,
    inputState.value,
    onSendMessage,
    setQueuedInput,
    t,
  ]);

  const submitMcpPromptFromInput = useCallback(async () => {
    const originalMessage = inputState.value.trim();
    let command = resolveTypedMcpPromptCommand(originalMessage);

    if (!command) {
      await loadMcpPromptCommands();
      command = resolveTypedMcpPromptCommand(originalMessage);
    }

    if (!command) {
      notificationService.warning(
        t('chatInput.noMatchingCommand', { defaultValue: 'No matching command' })
      );
      return;
    }

    const argsText = originalMessage
      .slice(command.command.length)
      .trim();
    const argValues = parseSlashArguments(argsText);
    const requiredArgs = command.arguments.filter(argument => argument.required);

    if (argValues.length < requiredArgs.length) {
      const requiredNames = requiredArgs.map(argument => argument.name).join(', ');
      notificationService.warning(
        t('chatInput.mcpPromptMissingArgs', {
          defaultValue: 'This MCP prompt requires arguments: {{args}}',
          args: requiredNames,
        })
      );
      return;
    }

    const originalPendingLargePastes = { ...pendingLargePastesRef.current };
    if (currentSessionId) {
      addToHistory(currentSessionId, originalMessage);
    }
    setHistoryIndex(-1);
    setSavedDraft('');
    dispatchInput({ type: 'CLEAR_VALUE' });
    clearPendingLargePastes();
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'modes', query: '', selectedIndex: 0 });

    try {
      const promptArguments = command.arguments.reduce<Record<string, string>>((acc, argument, index) => {
        const value = argValues[index];
        if (typeof value === 'string' && value.length > 0) {
          acc[argument.name] = value;
        }
        return acc;
      }, {});

      const prompt = await MCPAPI.getPrompt({
        serverId: command.serverId,
        promptName: command.promptName,
        arguments: Object.keys(promptArguments).length > 0 ? promptArguments : undefined,
      });

      const renderedPrompt = renderMcpPromptMessages(prompt.messages);
      if (!renderedPrompt.trim()) {
        throw new Error('MCP prompt returned no displayable content');
      }

      await sendMessage(renderedPrompt, {
        displayMessage: originalMessage,
      });
      dispatchInput({ type: 'DEACTIVATE' });
    } catch (error) {
      log.error('Failed to run MCP prompt command', {
        command: originalMessage,
        error,
      });
      pendingLargePastesRef.current = originalPendingLargePastes;
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      notificationService.error(
        error instanceof Error ? error.message : t('error.unknown'),
        {
          title: t('chatInput.mcpPromptFailed', { defaultValue: 'MCP prompt failed' }),
          duration: 5000,
        }
      );
    }
  }, [
    clearPendingLargePastes,
    addToHistory,
    currentSessionId,
    inputState.value,
    loadMcpPromptCommands,
    resolveTypedMcpPromptCommand,
    sendMessage,
    setQueuedInput,
    t,
  ]);
  
  const handleSendOrCancel = useCallback(async () => {
    if (!derivedState) return;
    
    const { sendButtonMode } = derivedState;
    const draftTrimmed = inputState.value.trim();

    // While generating, an empty control in `cancel` mode means stop. If the user has typed a follow-up,
    // never treat this path as cancel — that would call cancel_dialog_turn and abort the current round early.
    if (sendButtonMode === 'cancel' && !draftTrimmed) {
      await transition(SessionExecutionEvent.USER_CANCEL);
      return;
    }
    
    if (sendButtonMode === 'retry') {
      await transition(SessionExecutionEvent.RESET);
    }
    
    if (!draftTrimmed) return;
    
    const originalMessage = draftTrimmed;
    const originalPendingLargePastes = { ...pendingLargePastesRef.current };
    const message = expandPendingLargePastes(originalMessage).trim();
    const messageCharCount = getCharacterCount(message);

    if (/^\/compact\s*$/i.test(message)) {
      await submitCompactFromInput();
      return;
    }

    if (/^\/init\s*$/i.test(message)) {
      await submitInitFromInput();
      return;
    }

    if (resolveTypedMcpPromptCommand(message)) {
      await submitMcpPromptFromInput();
      return;
    }

    if (message.toLowerCase().startsWith('/compact')) {
      notificationService.warning(
        t('chatInput.compactUsage', { defaultValue: 'Use /compact without extra arguments.' })
      );
      return;
    }

    if (message.toLowerCase().startsWith('/init')) {
      notificationService.warning(
        t('chatInput.initUsage', { defaultValue: 'Use /init without extra arguments.' })
      );
      return;
    }
    
    // Add to history before clearing (session-scoped)
    if (currentSessionId) {
      addToHistory(currentSessionId, message);
    }
    setHistoryIndex(-1);
    setSavedDraft('');
    
    dispatchInput({ type: 'CLEAR_VALUE' });
    clearPendingLargePastes();
    // Clear machine queue too; otherwise the queuedInput→input sync effect puts the text back after send.
    setQueuedInput(null);

    if (messageCharCount > CHAT_INPUT_CONFIG.largePaste.maxMessageChars) {
      notificationService.error(
        t('input.messageTooLarge', {
          max: CHAT_INPUT_CONFIG.largePaste.maxMessageChars,
          count: messageCharCount,
          defaultValue: 'Message exceeds the maximum length of {{max}} characters ({{count}} provided).',
        }),
        { duration: 4000 }
      );
      pendingLargePastesRef.current = originalPendingLargePastes;
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      return;
    }

    try {
      await sendMessage(message);
      clearPendingLargePastes();
      dispatchInput({ type: 'CLEAR_VALUE' });
      dispatchInput({ type: 'DEACTIVATE' });
    } catch (error) {
      log.error('Failed to send message', { error });
      pendingLargePastesRef.current = originalPendingLargePastes;
      dispatchInput({ type: 'ACTIVATE' });
      dispatchInput({ type: 'SET_VALUE', payload: originalMessage });
      if (derivedState?.isProcessing) {
        setQueuedInput(originalMessage);
      }
    }
  }, [
    inputState.value,
    derivedState,
    transition,
    sendMessage,
    addToHistory,
    currentSessionId,
    clearPendingLargePastes,
    expandPendingLargePastes,
    setQueuedInput,
    submitCompactFromInput,
    submitInitFromInput,
    submitMcpPromptFromInput,
    t,
    resolveTypedMcpPromptCommand,
  ]);
  
  const getFilteredSwitchableModes = useCallback(() => {
    if (!canSwitchModes) return [];
    if (!slashCommandState.query) return switchableModes;
    return switchableModes.filter(
      mode =>
        mode.name.toLowerCase().includes(slashCommandState.query) ||
        mode.id.toLowerCase().includes(slashCommandState.query)
    );
  }, [canSwitchModes, switchableModes, slashCommandState.query]);

  const applyModeChange = useCallback((modeId: string) => {
    dispatchMode({
      type: 'SET_CURRENT_MODE',
      payload: modeId,
    });

    try {
      sessionStorage.setItem('ai00-x:flowchat:lastMode', modeId);
    } catch {
      // ignore
    }

    if (currentSessionId) {
      FlowChatStore.getInstance().updateSessionMode(currentSessionId, modeId);
    }
  }, [currentSessionId]);

  const requestModeChange = useCallback((modeId: string) => {
    if (!canSwitchModes) {
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      return;
    }

    if (modeId === currentMode) {
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      return;
    }

    if (!switchableModes.some(mode => mode.id === modeId)) {
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      return;
    }

    applyModeChange(modeId);
    dispatchMode({ type: 'CLOSE_DROPDOWN' });
  }, [applyModeChange, canSwitchModes, currentMode, switchableModes]);
  
  const selectSlashCommandMode = useCallback((modeId: string) => {
    requestModeChange(modeId);
    
    dispatchInput({ type: 'CLEAR_VALUE' });
    setSlashCommandState({
      isActive: false,
      kind: 'modes',
      query: '',
      selectedIndex: 0,
    });
  }, [requestModeChange]);

  const selectSlashSkill = useCallback((skillName: string) => {
    const line = t('chatInput.insertSkillLine', { name: skillName });
    const cur = inputState.value;
    const next = cur.trim() ? `${cur.trimEnd()}\n\n${line}` : line;
    dispatchInput({ type: 'SET_VALUE', payload: next });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'modes', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [inputState.value, setQueuedInput, t]);

  const selectSlashPromptCommand = useCallback((item: SlashMcpPromptItem) => {
    const hasArguments = item.arguments.length > 0;
    dispatchInput({
      type: 'SET_VALUE',
      payload: hasArguments ? `${item.command} ` : item.command,
    });
    setQueuedInput(null);
    setSlashCommandState({ isActive: false, kind: 'modes', query: '', selectedIndex: 0 });
    window.setTimeout(() => richTextInputRef.current?.focus(), 0);
  }, [setQueuedInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (slashCommandState.isActive) {
      if (!(slashCommandState.kind === 'modes' && !canSwitchModes)) {
        const items =
          slashCommandState.kind === 'modes'
            ? getFilteredSwitchableModes()
            : getSlashPickerItems();
        const maxIndex = Math.max(0, items.length - 1);
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashCommandState(prev => ({
            ...prev,
            selectedIndex: Math.min(prev.selectedIndex + 1, maxIndex),
          }));
          return;
        }
        
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashCommandState(prev => ({
            ...prev,
            selectedIndex: Math.max(prev.selectedIndex - 1, 0),
          }));
          return;
        }
        
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (items.length > 0) {
            if (slashCommandState.kind === 'modes') {
              const mode = items[slashCommandState.selectedIndex] as any;
              selectSlashCommandMode(mode.id);
            } else {
              const item = items[slashCommandState.selectedIndex] as SlashPickerItem;
              if (item.kind === 'mode') {
                selectSlashCommandMode(item.id);
              } else if (item.kind === 'mcpPrompt') {
                selectSlashPromptCommand(item);
              } else {
                selectSlashSkill(item.name);
              }
            }
          }
          return;
        }
        
        if (e.key === 'Escape') {
          e.preventDefault();
          setSlashCommandState({ isActive: false, kind: 'modes', query: '', selectedIndex: 0 });
          dispatchInput({ type: 'CLEAR_VALUE' });
          return;
        }
        
        if (e.key === 'Tab') {
          e.preventDefault();
          if (items.length > 0) {
            if (slashCommandState.kind === 'modes') {
              const mode = items[slashCommandState.selectedIndex] as any;
              selectSlashCommandMode(mode.id);
            } else {
              const item = items[slashCommandState.selectedIndex] as SlashPickerItem;
              if (item.kind === 'mode') {
                selectSlashCommandMode(item.id);
              } else if (item.kind === 'mcpPrompt') {
                selectSlashPromptCommand(item);
              } else {
                selectSlashSkill(item.name);
              }
            }
          }
          return;
        }
      }
    }

    // History navigation with up/down arrows
    // Only handle when not in slash command mode and not composing
    if (!slashCommandState.isActive && inputHistory.length > 0) {
      const selection = window.getSelection();
      const editor = richTextInputRef.current;
      
      if (selection && selection.rangeCount > 0 && editor) {
        const range = selection.getRangeAt(0);
        
        // Check cursor position
        const isAtStart = range.collapsed && range.startOffset === 0 && 
                          (range.startContainer === editor || 
                           (range.startContainer.nodeType === Node.TEXT_NODE && 
                            range.startContainer.previousSibling === null &&
                            range.startContainer.parentNode === editor));
        
        // For end position, we need to check if cursor is at the end of content
        const isAtEnd = (() => {
          if (!range.collapsed) return false;
          const editorContent = editor.textContent || '';
          let cursorPos = 0;
          const traverse = (node: Node): boolean => {
            if (node === range.startContainer) {
              if (node.nodeType === Node.TEXT_NODE) {
                cursorPos += range.startOffset;
              }
              return true;
            }
            if (node.nodeType === Node.TEXT_NODE) {
              cursorPos += (node.textContent || '').length;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              for (const child of Array.from(node.childNodes)) {
                if (traverse(child)) return true;
              }
            }
            return false;
          };
          traverse(editor);
          return cursorPos === editorContent.length;
        })();
        
        // Arrow Up at start of line -> go back in history
        if (e.key === 'ArrowUp' && isAtStart) {
          e.preventDefault();
          
          // Save draft if starting navigation
          if (historyIndex === -1 && inputState.value.trim()) {
            setSavedDraft(inputState.value);
          }
          
          // Navigate back (older messages)
          if (historyIndex < inputHistory.length - 1) {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            dispatchInput({ type: 'SET_VALUE', payload: inputHistory[newIndex] });
          }
          return;
        }
        
        // Arrow Down at end of line -> go forward in history
        if (e.key === 'ArrowDown' && isAtEnd) {
          e.preventDefault();
          
          if (historyIndex > 0) {
            // Navigate forward (newer messages)
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);
            dispatchInput({ type: 'SET_VALUE', payload: inputHistory[newIndex] });
          } else if (historyIndex === 0) {
            // Return to draft/empty
            setHistoryIndex(-1);
            dispatchInput({ type: 'SET_VALUE', payload: savedDraft });
          }
          return;
        }
      }
    }
    
    const isComposing = (e.nativeEvent as KeyboardEvent).isComposing || isImeComposingRef.current;
    const justFinishedComposition = Date.now() - lastImeCompositionEndAtRef.current < IME_ENTER_GUARD_MS;
    
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isComposing || justFinishedComposition) {
        return;
      }
      
      e.preventDefault();

      if (derivedState?.isProcessing) {
        if (!inputState.value.trim()) return;
        void handleSendOrCancel();
        return;
      }

      handleSendOrCancel();
    }
    
    if (e.key === 'Escape' && derivedState?.canCancel) {
      e.preventDefault();
      transition(SessionExecutionEvent.USER_CANCEL);
    }
  }, [handleSendOrCancel, derivedState, transition, slashCommandState, getFilteredSwitchableModes, getSlashPickerItems, selectSlashCommandMode, selectSlashSkill, selectSlashPromptCommand, canSwitchModes, historyIndex, inputHistory, savedDraft, inputState.value]);

  const handleImeCompositionStart = useCallback(() => {
    isImeComposingRef.current = true;
  }, []);

  const handleImeCompositionEnd = useCallback(() => {
    isImeComposingRef.current = false;
    lastImeCompositionEndAtRef.current = Date.now();
  }, []);

  const handleImageInput = useCallback(() => {
    const remaining = CHAT_INPUT_CONFIG.image.maxCount - currentImageCount;
    if (remaining <= 0) {
      notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = CHAT_INPUT_CONFIG.image.acceptedTypes.join(',');
    input.multiple = true;
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;
      
      const fileArray = Array.from(files).slice(0, remaining);
      if (files.length > remaining) {
        notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
      }
      
      let successCount = 0;
      
      for (const file of fileArray) {
        try {
          const imageContext = await createImageContextFromFile(file);
          addContext(imageContext);
          
          if (richTextInputRef.current && (richTextInputRef.current as any).insertTag) {
            (richTextInputRef.current as any).insertTag(imageContext);
          }
          
          successCount++;
        } catch (error) {
          log.error('Failed to process image', { fileName: file.name, error });
          notificationService.error(
            `${file.name}: ${error instanceof Error ? error.message : t('error.processingFailed')}`,
            { duration: 3000 }
          );
        }
      }
      
      if (successCount > 0) {
        notificationService.success(
          t('input.imageAddedSuccess', { count: successCount }),
          { duration: 2000 }
        );
      }
    };
    
    input.click();
  }, [addContext, currentImageCount, t]);
  
  const focusRichTextInputSoon = useCallback(() => {
    window.requestAnimationFrame(() => {
      richTextInputRef.current?.focus();
    });
  }, []);

  const insertSkillIntoInput = useCallback(
    (skillName: string) => {
      const line = t('chatInput.insertSkillLine', { name: skillName });
      dispatchInput({ type: 'ACTIVATE' });
      const cur = inputState.value;
      const next = cur.trim() ? `${cur.trimEnd()}\n\n${line}` : line;
      dispatchInput({ type: 'SET_VALUE', payload: next });
      clearSkillsTimer();
      setSkillsFlyoutOpen(false);
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      focusRichTextInputSoon();
    },
    [clearSkillsTimer, focusRichTextInputSoon, inputState.value, t]
  );

  const handleBoostPickImage = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      handleImageInput();
    },
    [handleImageInput]
  );

  const handleBoostOpenAtContext = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
    dispatchMode({ type: 'CLOSE_DROPDOWN' });
    dispatchInput({ type: 'ACTIVATE' });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = richTextInputRef.current;
        if (el && typeof (el as unknown as { openMention?: () => void }).openMention === 'function') {
          (el as unknown as { openMention: () => void }).openMention();
        }
      });
    });
  }, []);

  const handleOpenSkillsLibrary = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      clearSkillsTimer();
      setSkillsFlyoutOpen(false);
      dispatchMode({ type: 'CLOSE_DROPDOWN' });
      openScene('skills' as SceneTabId);
    },
    [clearSkillsTimer, openScene]
  );
  
  const handleActivate = useCallback((e?: React.MouseEvent) => {
    if (e?.target instanceof HTMLButtonElement || 
        (e?.target instanceof Element && e.target.closest('button'))) {
      if (!inputState.isActive) {
        dispatchInput({ type: 'ACTIVATE' });
      }
      return;
    }
    
    if (!inputState.isActive) {
      dispatchInput({ type: 'ACTIVATE' });
      focusRichTextInputSoon();
    }
  }, [focusRichTextInputSoon, inputState.isActive]);

  // Global space-to-activate: when collapsed and no editable element is focused
  useEffect(() => {
    if (inputState.isActive) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]') !== null;

      if (e.key === 'Escape' && derivedState?.canCancel) {
        if (isEditable) return;
        e.preventDefault();
        void transition(SessionExecutionEvent.USER_CANCEL);
        return;
      }

      if (e.key !== ' ') return;
      if (isEditable) return;

      e.preventDefault();
      dispatchInput({ type: 'ACTIVATE' });
      focusRichTextInputSoon();
    };

    // Capture phase so activation runs before nested handlers; Space must dispatch ACTIVATE, not only focus().
    document.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [derivedState?.canCancel, focusRichTextInputSoon, inputState.isActive, transition]);
  
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // Do not collapse when clicking the scroll-to-latest bar.
      if ((target as Element)?.closest?.('.scroll-to-latest-bar')) return;
      if (
        inputState.isActive &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        // While IME is composing, React value can still be empty (RichTextInput skips onChange),
        // but the editor DOM holds preedit text — collapsing would show space-hint on top of it.
        if (inputState.value.trim() === '' && !isImeComposingRef.current) {
          dispatchInput({ type: 'DEACTIVATE' });
        }
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [inputState.isActive, inputState.value]);

  // Listen for prefill-chat-input events (e.g. from PlanInputCard "revise plan")
  useEffect(() => {
    const handler = (e: Event) => {
      const { text } = (e as CustomEvent).detail ?? {};
      if (typeof text === 'string') {
        dispatchInput({ type: 'ACTIVATE' });
        dispatchInput({ type: 'SET_VALUE', payload: text });
        focusRichTextInputSoon();
      }
    };
    window.addEventListener('ai00-x:prefill-chat-input', handler);
    return () => window.removeEventListener('ai00-x:prefill-chat-input', handler);
  }, [focusRichTextInputSoon]);

  useEffect(() => {
    const dropZone = containerRef.current?.closest('.ai00-x-chat-input-drop-zone') as HTMLElement | null;
    const el = dropZone ?? containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setChatInputHeight(el.offsetHeight);
    });
    observer.observe(el);
    setChatInputHeight(el.offsetHeight);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isCollapsedProcessing = !inputState.isActive && !!derivedState?.isProcessing;
  const petReplacesStopChrome = agentCompanionEnabled && isCollapsedProcessing;
  const petStopClickable = petReplacesStopChrome && !!derivedState?.canCancel;
  const collapsedPetSplitSend =
    petReplacesStopChrome && derivedState?.sendButtonMode === 'split';

  const renderActionButton = () => {
    if (!derivedState) return <IconButton className="ai00-x-chat-input__send-button" disabled size="small"><ArrowUp size={11} /></IconButton>;

    if (petReplacesStopChrome) {
      const { sendButtonMode } = derivedState;
      if (sendButtonMode === 'cancel') {
        return null;
      }
      if (sendButtonMode === 'split') {
        return (
          <IconButton
            className="ai00-x-chat-input__send-button"
            onClick={handleSendOrCancel}
            disabled={!inputState.value.trim()}
            data-testid="chat-input-send-btn"
            tooltip={t('input.sendShortcut')}
            size="small"
          >
            <ArrowUp size={11} />
          </IconButton>
        );
      }
    }

    const { sendButtonMode, hasQueuedInput } = derivedState;
    
    if (sendButtonMode === 'cancel') {
      return (
        <Tooltip content={t('input.stopGeneration')}>
          <div
            className="ai00-x-chat-input__send-button ai00-x-chat-input__send-button--breathing"
            onClick={handleSendOrCancel}
            data-testid="chat-input-cancel-btn"
          >
            <div className="ai00-x-chat-input__breathing-circle" />
            {hasQueuedInput && <span className="ai00-x-chat-input__queued-badge">1</span>}
          </div>
        </Tooltip>
      );
    }
    
    if (sendButtonMode === 'retry') {
      return (
        <IconButton
          className="ai00-x-chat-input__send-button ai00-x-chat-input__send-button--retry"
          onClick={handleSendOrCancel}
          tooltip={t('input.retry')}
          size="small"
        >
          <RotateCcw size={11} />
        </IconButton>
      );
    }

    if (sendButtonMode === 'split') {
      return (
        <div className="ai00-x-chat-input__split-actions">
          <Tooltip content={t('input.stopGeneration')}>
            <div
              className="ai00-x-chat-input__send-button ai00-x-chat-input__send-button--breathing"
              onClick={() => {
                void transition(SessionExecutionEvent.USER_CANCEL);
              }}
              data-testid="chat-input-cancel-btn"
            >
              <div className="ai00-x-chat-input__breathing-circle" />
            </div>
          </Tooltip>
          <IconButton
            className="ai00-x-chat-input__send-button"
            onClick={handleSendOrCancel}
            disabled={!inputState.value.trim()}
            data-testid="chat-input-send-btn"
            tooltip={t('input.sendShortcut')}
            size="small"
          >
            <ArrowUp size={11} />
          </IconButton>
        </div>
      );
    }
    
    return (
      <IconButton
        className="ai00-x-chat-input__send-button"
        onClick={handleSendOrCancel}
        disabled={!inputState.value.trim()}
        data-testid="chat-input-send-btn"
        tooltip={t('input.sendShortcut')}
        size="small"
      >
        <ArrowUp size={11} />
      </IconButton>
    );
  };

  return (
    <>
      <ContextDropZone
        acceptedTypes={['file', 'directory', 'image', 'code-snippet', 'mermaid-diagram']}
        className="ai00-x-chat-input-drop-zone"
        onContextAdded={(context) => {
          if (context.type === 'image') {
            if (!isMultimodalModel) {
              notificationService.warning(t('input.imageNotSupported'), { duration: 3000 });
              return;
            }
            if (currentImageCount >= CHAT_INPUT_CONFIG.image.maxCount) {
              notificationService.warning(t('input.maxImagesWarning', { count: CHAT_INPUT_CONFIG.image.maxCount }), { duration: 3000 });
              return;
            }
          }
          if (richTextInputRef.current && (richTextInputRef.current as any).insertTag) {
            (richTextInputRef.current as any).insertTag(context);
          }
          if (!inputState.isActive) {
            dispatchInput({ type: 'ACTIVATE' });
          }
        }}
      >
        <div 
          ref={containerRef}
          className={`ai00-x-chat-input ${inputState.isActive ? 'ai00-x-chat-input--active' : 'ai00-x-chat-input--collapsed'} ${inputState.isExpanded ? 'ai00-x-chat-input--expanded' : ''} ${derivedState?.isProcessing ? 'ai00-x-chat-input--processing' : ''} ${showCollapsedPet ? 'ai00-x-chat-input--pet-visible' : ''} ${petReplacesStopChrome ? 'ai00-x-chat-input--pet-replaces-stop' : ''} ${collapsedPetSplitSend ? 'ai00-x-chat-input--pet-split-send' : ''} ${className}`}
          onClick={!inputState.isActive ? handleActivate : undefined}
          data-testid="chat-input-container"
        >
        {recommendationContext && (
          <SmartRecommendations
            context={recommendationContext}
            className="ai00-x-chat-input__recommendations"
          />
        )}

        <div className="ai00-x-chat-input__container">
          {isArchived ? (
            <div className="ai00-x-chat-input__rating-done">
              <CheckCircle size={16} />
              <span>{t('taskComplete.archived')}</span>
            </div>
          ) : showRatingCard && planFilePath && badgeMode === 'rating' && !ratingDone ? (
            <div className="ai00-x-chat-input__rating-panel">
              <div className="ai00-x-chat-input__corner-badge ai00-x-chat-input__corner-badge--rating" onClick={() => setBadgeMode('chat')}>
                <span className="ai00-x-chat-input__corner-badge__text">CHAT</span>
              </div>
              <div className="ai00-x-chat-input__rating-stars">
                <StarRating value={ratingValue} onChange={setRatingValue} size="lg" />
              </div>
              <div className="ai00-x-chat-input__rating-actions">
                <button
                  className="ai00-x-chat-input__rating-submit"
                  disabled={ratingSubmitting || ratingValue === 0}
                  onClick={async () => {
                    if (!taskSessionId) return;
                    setRatingSubmitting(true);
                    try {
                      await agentAPI.submitRating(taskSessionId, {
                        planRating: ratingValue,
                        planFeedback: '',
                        completeRating: 0,
                        completeFeedback: '',
                      });
                      const result = await agentAPI.archiveAndMerge(taskSessionId);
                      if (result.success) {
                        FlowChatStore.getInstance().setCompletionPhase(taskSessionId, 'archived');
                      }
                      setRatingDone(true);
                    } catch (e) {
                      notificationService.error(String(e));
                    } finally {
                      setRatingSubmitting(false);
                    }
                  }}
                >
                  {ratingSubmitting ? <Loader2 size={14} className="spin" /> : null}
                  {t('taskComplete.submitAndArchive')}
                </button>
              </div>
            </div>
          ) : showRatingCard && planFilePath && badgeMode === 'rating' && ratingDone ? (
            <div className="ai00-x-chat-input__rating-done">
              <CheckCircle size={16} />
              <span>{t('taskComplete.archived')}</span>
            </div>
          ) : showRatingCard && !planFilePath ? (
            <div className="ai00-x-chat-input__rating-panel">
              <div className="ai00-x-chat-input__rating-actions">
                <button
                  className="ai00-x-chat-input__rating-submit"
                  disabled={ratingSubmitting}
                  onClick={async () => {
                    if (!taskSessionId) return;
                    setRatingSubmitting(true);
                    try {
                      const result = await agentAPI.archiveAndMerge(taskSessionId);
                      if (result.success) {
                        FlowChatStore.getInstance().setCompletionPhase(taskSessionId, 'archived');
                      }
                      setRatingDone(true);
                    } catch (e) {
                      notificationService.error(String(e));
                    } finally {
                      setRatingSubmitting(false);
                    }
                  }}
                >
                  {ratingSubmitting ? <Loader2 size={14} className="spin" /> : null}
                  {t('taskComplete.archive', { defaultValue: '归档' })}
                </button>
              </div>
            </div>
          ) : (
            <div className={`ai00-x-chat-input__box ${inputState.isExpanded ? 'ai00-x-chat-input__box--expanded' : ''}`}>
            {showRatingCard && (
              <div className="ai00-x-chat-input__corner-badge" onClick={() => setBadgeMode('rating')}>
                <span className="ai00-x-chat-input__corner-badge__text">DONE</span>
              </div>
            )}
            {showCollapsedPet && (
              <div
                className={[
                  'ai00-x-chat-input__pet-wrap',
                  petReplacesStopChrome ? 'ai00-x-chat-input__pet-wrap--shift' : '',
                  collapsedPetSplitSend ? 'ai00-x-chat-input__pet-wrap--split' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="ai00-x-chat-input__pet-inner">
                  {petStopClickable ? (
                    <button
                      type="button"
                      className="ai00-x-chat-input__pet-stop-btn"
                      onClick={e => {
                        e.stopPropagation();
                        void transition(SessionExecutionEvent.USER_CANCEL);
                      }}
                      aria-label={t('input.stopGeneration')}
                    >
                      <ChatInputPixelPet
                        mood={petMood}
                        layout={petReplacesStopChrome ? 'stopRight' : 'center'}
                      />
                    </button>
                  ) : (
                    <ChatInputPixelPet
                      mood={petMood}
                      layout={petReplacesStopChrome ? 'stopRight' : 'center'}
                    />
                  )}
                </div>
              </div>
            )}
            <div className="ai00-x-chat-input__input-area">
              <RichTextInput
                ref={richTextInputRef}
                value={inputState.value}
                onChange={handleInputChange}
                onLargePaste={createLargePastePlaceholder}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleImeCompositionStart}
                onCompositionEnd={handleImeCompositionEnd}
                placeholder={inputState.isActive ? t('input.placeholder') : ''}
                disabled={false}
                contexts={contexts}
                onRemoveContext={removeContext}
                onMentionStateChange={setMentionState}
                data-testid="chat-input-textarea"
              />

              {!inputState.isActive &&
                !inputState.value.trim() &&
                !agentCompanionEnabled && (
                <span className="ai00-x-chat-input__space-hint">
                  <Trans
                    i18nKey="input.spaceToActivate"
                    t={t}
                    components={{
                      space: <span className="ai00-x-chat-input__space-key" />,
                    }}
                  />
                </span>
              )}
              
              <FileMentionPicker
                isOpen={mentionState.isActive}
                searchQuery={mentionState.query}
                workspacePath={workspacePath}
                onSelect={(context: FileContext | DirectoryContext) => {
                  addContext(context);
                  
                  if (richTextInputRef.current && (richTextInputRef.current as any).insertTagReplacingMention) {
                    (richTextInputRef.current as any).insertTagReplacingMention(context);
                  }
                }}
                onClose={() => {
                  if (richTextInputRef.current && (richTextInputRef.current as any).closeMention) {
                    (richTextInputRef.current as any).closeMention();
                  }
                  setMentionState({ isActive: false, query: '', startOffset: 0 });
                }}
              />
              
              {slashCommandState.isActive && (() => {
                if (slashCommandState.kind === 'all') {
                  const items = getSlashPickerItems();
                  return (
                    <div className="ai00-x-chat-input__slash-command-picker">
                      <div className="ai00-x-chat-input__slash-command-header">
                        <span>{t('chatInput.selectSkill', { defaultValue: 'Choose a skill' })}</span>
                        <span className="ai00-x-chat-input__slash-command-hint">{t('chatInput.selectHint')}</span>
                      </div>
                      <div className="ai00-x-chat-input__slash-command-list" ref={slashListRef}>
                        {mcpPromptCommandsLoading && items.length === 0 ? (
                          <div className="ai00-x-chat-input__slash-command-empty">
                            {t('chatInput.loadingMcpPrompts', { defaultValue: 'Loading MCP prompts…' })}
                          </div>
                        ) : items.length > 0 ? (
                          items.map((item, index) => (
                            <div
                              key={`${item.kind}-${item.id}`}
                              className={`ai00-x-chat-input__slash-command-item ${index === slashCommandState.selectedIndex ? 'ai00-x-chat-input__slash-command-item--selected' : ''} ${item.kind === 'mode' && item.id === modeState.current ? 'ai00-x-chat-input__slash-command-item--active' : ''}`}
                              onClick={() => {
                                if (item.kind === 'mode') {
                                  selectSlashCommandMode(item.id);
                                } else if (item.kind === 'mcpPrompt') {
                                  selectSlashPromptCommand(item);
                                } else {
                                  selectSlashSkill(item.name);
                                }
                              }}
                              onMouseEnter={() => setSlashCommandState(prev => ({ ...prev, selectedIndex: index }))}
                            >
                              <span className="ai00-x-chat-input__slash-command-name">
                                {item.kind === 'mode' ? `/${item.id}` : item.kind === 'mcpPrompt' ? item.command : item.name}
                              </span>
                              <span className="ai00-x-chat-input__slash-command-label">
                                {item.kind === 'mode'
                                  ? item.name
                                  : item.kind === 'mcpPrompt'
                                    ? `${item.serverName} · ${item.label}`
                                    : ''}
                              </span>
                              {item.kind === 'mode' && item.id === modeState.current && <span className="ai00-x-chat-input__slash-command-current">{t('chatInput.current')}</span>}
                            </div>
                          ))
                        ) : (
                          <div className="ai00-x-chat-input__slash-command-empty">
                            {t('chatInput.noMatchingCommand', { defaultValue: 'No matching command' })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                if (!canSwitchModes) return null;

                const filteredModes = getFilteredSwitchableModes();
                return (
                  <div className="ai00-x-chat-input__slash-command-picker">
                    <div className="ai00-x-chat-input__slash-command-header">
                      <span>{t('chatInput.addModeMenuTitle')}</span>
                      <span className="ai00-x-chat-input__slash-command-hint">{t('chatInput.selectHint')}</span>
                    </div>
                    <div className="ai00-x-chat-input__slash-command-list" ref={modesListRef}>
                      {filteredModes.length > 0 ? (
                        filteredModes.map((mode, index) => (
                          <div
                            key={mode.id}
                            className={`ai00-x-chat-input__slash-command-item ${index === slashCommandState.selectedIndex ? 'ai00-x-chat-input__slash-command-item--selected' : ''} ${mode.id === modeState.current ? 'ai00-x-chat-input__slash-command-item--active' : ''}`}
                            onClick={() => selectSlashCommandMode(mode.id)}
                            onMouseEnter={() => setSlashCommandState(prev => ({ ...prev, selectedIndex: index }))}
                          >
                            <span className="ai00-x-chat-input__slash-command-name">/{mode.id}</span>
                            <span className="ai00-x-chat-input__slash-command-label">{mode.name}</span>
                            {mode.id === modeState.current && <span className="ai00-x-chat-input__slash-command-current">{t('chatInput.current')}</span>}
                          </div>
                        ))
                      ) : (
                        <div className="ai00-x-chat-input__slash-command-empty">
                          {t('chatInput.noMatchingMode')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
            
            <div className="ai00-x-chat-input__actions">
              <div className="ai00-x-chat-input__actions-left">
                <div className="ai00-x-chat-input__agent-boost" ref={agentBoostRef}>
                  <Tooltip content={t('chatInput.addBoostTooltip')}>
                    <IconButton
                      className="ai00-x-chat-input__agent-boost-add"
                      variant="ghost"
                      size="xs"
                      aria-haspopup="menu"
                      aria-expanded={modeState.dropdownOpen}
                      onClick={e => {
                        e.stopPropagation();
                        dispatchMode({ type: 'TOGGLE_DROPDOWN' });
                      }}
                    >
                      <Plus size={14} strokeWidth={2.25} />
                    </IconButton>
                  </Tooltip>

                  {canSwitchModes && !TOP_LEVEL_AGENT_IDS.has(modeState.current) && (
                    <div
                      className={`ai00-x-chat-input__agent-capsule ai00-x-chat-input__agent-capsule--${modeState.current === 'debug' ? 'debug' : modeState.current}`}
                    >
                      <span className="ai00-x-chat-input__agent-capsule-label">
                        {t(`chatInput.modeNames.${modeState.current}`, { defaultValue: '' }) ||
                          modeState.available.find(m => m.id === modeState.current)?.name ||
                          modeState.current}
                      </span>
                      <button
                        type="button"
                        className="ai00-x-chat-input__agent-capsule-close"
                        aria-label={t('chatInput.resetToCore')}
                        onClick={e => {
                          e.stopPropagation();
                          applyModeChange(getDefaultTopLevelAgent());
                          dispatchMode({ type: 'CLOSE_DROPDOWN' });
                        }}
                      >
                        <X size={12} strokeWidth={2.5} />
                      </button>
                    </div>
                  )}

                  {modeState.dropdownOpen && (
                    <div className="ai00-x-chat-input__mode-dropdown ai00-x-chat-input__mode-dropdown--agent-boost">
                      {canSwitchModes && (
                        <>
                          <div className="ai00-x-chat-input__boost-section">
                            {switchableModes.length > 0 ? (
                              switchableModes.map(modeOption => {
                                const modeDescription =
                                  t(`chatInput.modeDescriptions.${modeOption.id}`, { defaultValue: '' }) ||
                                  modeOption.description ||
                                  modeOption.name;
                                const modeName =
                                  t(`chatInput.modeNames.${modeOption.id}`, { defaultValue: '' }) || modeOption.name;
                                return (
                                  <Tooltip key={modeOption.id} content={modeDescription} placement="left">
                                    <div
                                      className={`ai00-x-chat-input__mode-option ${modeState.current === modeOption.id ? 'ai00-x-chat-input__mode-option--active' : ''}`}
                                      onClick={e => {
                                        e.stopPropagation();
                                        requestModeChange(modeOption.id);
                                      }}
                                    >
                                      <span className="ai00-x-chat-input__mode-option-name">{modeName}</span>
                                      {modeState.current === modeOption.id && (
                                        <span className="ai00-x-chat-input__slash-command-current">{t('chatInput.current')}</span>
                                      )}
                                    </div>
                                  </Tooltip>
                                );
                              })
                            ) : (
                              <div className="ai00-x-chat-input__agent-boost-empty ai00-x-chat-input__agent-boost-empty--inline">
                                {t('chatInput.noIncrementalModes')}
                              </div>
                            )}
                          </div>

                          <div className="ai00-x-chat-input__boost-section-divider" aria-hidden />
                        </>
                      )}

                      <div className="ai00-x-chat-input__boost-section">
                        <div
                          role="button"
                          tabIndex={0}
                          className="ai00-x-chat-input__boost-context-row"
                          onClick={handleBoostOpenAtContext}
                          onKeyDown={e => e.key === 'Enter' && handleBoostOpenAtContext(e)}
                        >
                          <Files size={14} className="ai00-x-chat-input__boost-context-icon" aria-hidden />
                          <span>{t('chatInput.boostAddContext')}</span>
                        </div>

                        {isMultimodalModel && (
                        <div
                          role="button"
                          tabIndex={0}
                          className="ai00-x-chat-input__boost-context-row"
                          onClick={handleBoostPickImage}
                          onKeyDown={e => e.key === 'Enter' && handleBoostPickImage(e as any)}
                        >
                          <Image size={14} className="ai00-x-chat-input__boost-context-icon" aria-hidden />
                          <span>{t('input.addImage')}</span>
                        </div>
                        )}

                        <div
                          ref={skillsHostRef}
                          className="ai00-x-chat-input__boost-submenu-host"
                          onMouseEnter={openSkillsFlyout}
                          onMouseLeave={closeSkillsFlyout}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className="ai00-x-chat-input__boost-submenu-trigger"
                            aria-haspopup="menu"
                            aria-expanded={skillsFlyoutOpen}
                          >
                            <span className="ai00-x-chat-input__boost-submenu-trigger-main">
                              <Sparkles size={14} className="ai00-x-chat-input__boost-context-icon" aria-hidden />
                              <span>{t('chatInput.boostSkills')}</span>
                            </span>
                            <ChevronRight size={14} className="ai00-x-chat-input__boost-submenu-chevron" aria-hidden />
                          </div>
                          <div
                            className={[
                              'ai00-x-chat-input__boost-submenu-shell',
                              skillsFlyoutOpen ? 'ai00-x-chat-input__boost-submenu-shell--open' : '',
                              skillsFlyoutLeft ? 'ai00-x-chat-input__boost-submenu-shell--left' : '',
                              skillsFlyoutUp ? 'ai00-x-chat-input__boost-submenu-shell--up' : '',
                            ].filter(Boolean).join(' ')}
                            onMouseEnter={openSkillsFlyout}
                            onMouseLeave={closeSkillsFlyout}
                          >
                            <div className="ai00-x-chat-input__boost-submenu-panel">
                              {boostSkillsLoading ? (
                                <div className="ai00-x-chat-input__boost-submenu-loading">
                                  <Loader2 size={14} className="ai00-x-chat-input__boost-submenu-spinner" aria-hidden />
                                  <span>{t('chatInput.boostSkillsLoading')}</span>
                                </div>
                              ) : boostPanelSkills.length === 0 ? (
                                <div className="ai00-x-chat-input__boost-submenu-empty">{t('chatInput.boostSkillsEmpty')}</div>
                              ) : (
                                <div className="ai00-x-chat-input__boost-submenu-list">
                                  {boostPanelSkills.map(skill => (
                                    <div
                                      key={skill.name}
                                      role="button"
                                      tabIndex={0}
                                      className="ai00-x-chat-input__boost-submenu-item"
                                      title={skill.description || skill.name}
                                      onClick={e => {
                                        e.stopPropagation();
                                        insertSkillIntoInput(skill.name);
                                      }}
                                      onKeyDown={e => e.key === 'Enter' && insertSkillIntoInput(skill.name)}
                                    >
                                      <Sparkles size={12} className="ai00-x-chat-input__boost-submenu-item-icon" aria-hidden />
                                      <span className="ai00-x-chat-input__boost-submenu-item-name">{skill.name}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div
                                role="button"
                                tabIndex={0}
                                className="ai00-x-chat-input__boost-submenu-manage"
                                onClick={handleOpenSkillsLibrary}
                                onKeyDown={e => e.key === 'Enter' && handleOpenSkillsLibrary(e as any)}
                              >
                                {t('chatInput.openSkillsLibrary')}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <ModelSelector
                  currentMode={modeState.current}
                  sessionId={currentSessionId || undefined}
                  currentTokens={tokenUsage.current}
                  maxTokens={tokenUsage.max}
                />
              </div>
              <div className="ai00-x-chat-input__actions-right">
                {isCollapsedProcessing && !petReplacesStopChrome && (
                  <>
                    <span className="ai00-x-chat-input__capsule-divider" />
                    <span className="ai00-x-chat-input__cancel-shortcut">
                      <span className="ai00-x-chat-input__space-key">Esc</span>
                      <span>{t('input.cancelShortcut')}</span>
                    </span>
                  </>
                )}

                {renderActionButton()}
              </div>
            </div>
          </div>
          )}
        </div>
      </div>
    </ContextDropZone>
    </>
  );
};

export default ChatInput;

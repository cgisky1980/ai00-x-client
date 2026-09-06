/**
 * SessionChatPanel — 会话对话浮层（可拖动、可多开并存，替代模态弹窗）。
 *
 * 双击工灵 / todo 看板「打开对话 · 干预」的落点：独立对应一个 dsh 会话的
 * 完整对话——历史基线（dshSession.history）+ 实时流（connectMux 过滤本会话）
 * 统一进事件数组后 foldEvents 折叠；可发消息（dshSession.prompt）/ 停止（cancel）。
 *
 * 浮层配方对齐 SettingsDialog/MusicPopup（overlay 主窗穿透机制）：
 * 根节点 `.no-penetrate` + useDraggable（setDragging + refreshRegions 跟随）+
 * 全 token 化样式。多实例层叠错位由打开顺序（openedAt）决定。
 * 设计依据：参考/设计-Agent剧场与名场面.md §3.5。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GripHorizontal, X } from 'lucide-react';
import { ModelSelector, PromptInput } from '@/component-library';
import {
  connectMux,
  dshApproval,
  dshQuestion,
  dshSession,
  foldEvents,
  type DshApproval,
  type DshMessage,
  type DshMuxFrame,
  type DshQuestion,
  type DshQuestionAnswerItem,
  type DshSessionEvent,
  type DshSessionModels,
} from '@/infrastructure/api/service-api/DshAPI';
import { useDraggable, refreshRegions, setDragging } from '../../../infrastructure/overlay';
import { usePopupResize } from '../../../tools/island/hooks/usePopupResize';
import { ApprovalCard, MessageBubble, QuestionCard } from '../../scenes/dsh/DshChatPieces';
// 消息/输入区样式类来自策场景（__msg* / __composer），必须引入该样式表
import '../../scenes/dsh/DshScene.scss';
import type { ChatPanelInfo } from './theaterStore';

interface SessionChatPanelProps {
  sessionId: string;
  info: ChatPanelInfo;
  /** 层叠序号（0 起，决定默认错位） */
  index: number;
  onClose: () => void;
}

export const SessionChatPanel: React.FC<SessionChatPanelProps> = ({
  sessionId,
  info,
  index,
  onClose,
}) => {
  const { t } = useTranslation('agentTheater');
  const tDsh = useTranslation('scenes/dsh').t;
  const [messages, setMessages] = useState<DshMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [approvals, setApprovals] = useState<DshApproval[]>([]);
  const [questions, setQuestions] = useState<DshQuestion[]>([]);
  const [models, setModels] = useState<DshSessionModels | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** 基线 + 实时事件统一数组（foldEvents 的输入） */
  const eventsRef = useRef<DshSessionEvent[]>([]);

  const initialPos = useRef({
    x: Math.max(0, Math.min(window.innerWidth - 360, 160 + (index % 6) * 32)),
    y: Math.max(0, Math.min(window.innerHeight - 240, 96 + (index % 6) * 28)),
  });

  const {
    position,
    setPosition,
    elementRef,
    handleMouseDown,
    isDragging,
  } = useDraggable({
    initialPosition: initialPos.current,
    // 仅标题栏起手拖拽；对话内容区/输入框排除（保留文本选择与交互）
    excludeSelector: '.ai00-session-float__chat',
    onDragStart: () => setDragging(true),
    onDragEnd: () => setDragging(false),
  });

  // 右下角拖拽调大小（区域刷新靠 resize 期间的 setDragging 跟随模式）
  const {
    size,
    activeResize,
    handleResizeMouseDown,
  } = usePopupResize({
    initialSize: { width: 360, height: 420 },
    minWidth: 280,
    minHeight: 240,
    getPosition: () => position,
    setPosition,
    elementRef,
  });

  useEffect(() => {
    setDragging(activeResize !== null);
  }, [activeResize]);

  // 位置变化 → 捕获区域跟随（对齐 SettingsDialog 配方）
  useEffect(() => {
    const timer = setTimeout(() => refreshRegions(), 200);
    return () => clearTimeout(timer);
  }, [position]);

  const refreshRunning = useCallback(async (): Promise<void> => {
    try {
      const { items } = await dshSession.list();
      const self = items.find((it) => it.sessionId === sessionId);
      setAgentRunning(Boolean(self?.running));
    } catch {
      // 列表拉不到 → 保持现状
    }
  }, [sessionId]);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const res = await dshSession.models(sessionId);
      setModels(res);
    } catch {
      setModels(null); // 模型目录拉不到 → ModelSelector 走 loading 态
    }
  }, [sessionId]);

  const reloadBaseline = useCallback(async (): Promise<void> => {
    try {
      const { events } = await dshSession.history(sessionId);
      eventsRef.current = events.map(e => e.event);
      setMessages(foldEvents(eventsRef.current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  // 打开时拉历史基线 + 运行态
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    eventsRef.current = [];
    void (async () => {
      await reloadBaseline();
      await refreshRunning();
      await loadModels();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadBaseline, refreshRunning, loadModels]);

  // 实时流（浮层存在期间订阅）
  useEffect(() => {
    if (!sessionId) return undefined;
    const conn = connectMux((frame: DshMuxFrame, frameRpcId: string) => {
      // 审批/提问（mux 重连会重放 pending 帧 → 按 rpcId 去重）
      if (frame.type === 'approval/requested' && frame.sessionId === sessionId) {
        setApprovals(prev =>
          prev.some(a => a.rpcId === frameRpcId)
            ? prev
            : [...prev, {
                rpcId: frameRpcId,
                sessionId,
                approvalId: frame.approvalId,
                toolName: frame.toolName,
                callId: frame.callId,
                reason: frame.reason,
              }],
        );
        return;
      }
      if (frame.type === 'approval/resolved' && frame.sessionId === sessionId) {
        setApprovals(prev => prev.filter(a => a.approvalId !== frame.approvalId));
        return;
      }
      if (frame.type === 'question/requested' && frame.sessionId === sessionId) {
        setQuestions(prev =>
          prev.some(q => q.rpcId === frameRpcId)
            ? prev
            : [...prev, { rpcId: frameRpcId, sessionId, questions: frame.questions }],
        );
        return;
      }
      if (frame.type === 'question/resolved' && frame.sessionId === sessionId) {
        setQuestions(prev => prev.filter(q => q.rpcId !== frame.questionRpcId));
        return;
      }
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return;
      if (frame.event.type === 'turn/end') {
        // turn 结束后以引擎基线为权威重拉（含 usage 与完整折叠），并刷新运行态
        void reloadBaseline();
        void refreshRunning();
        return;
      }
      eventsRef.current = [...eventsRef.current, frame.event];
      setMessages(foldEvents(eventsRef.current));
    });
    return () => conn.close();
  }, [sessionId, reloadBaseline, refreshRunning, loadModels]);

  // 自动滚底
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await dshSession.prompt(sessionId, text);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await dshSession.cancel(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const respondApproval = async (rpcId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
    const a = approvals.find(x => x.rpcId === rpcId);
    if (!a) return;
    const receipt = await dshApproval.respond(rpcId, sessionId, a.approvalId, outcome);
    if (receipt.accepted) setApprovals(prev => prev.filter(x => x.rpcId !== rpcId));
  };

  const respondQuestion = async (rpcId: string, answers: DshQuestionAnswerItem[]): Promise<void> => {
    const receipt = await dshQuestion.respond(rpcId, sessionId, answers);
    if (receipt.accepted) setQuestions(prev => prev.filter(q => q.rpcId !== rpcId));
  };

  const cancelQuestion = (rpcId: string): void => {
    void dshQuestion.cancel(rpcId);
    setQuestions(prev => prev.filter(q => q.rpcId !== rpcId));
  };

  const handleSelectModel = async (groupId: string, modelId: string): Promise<void> => {
    try {
      const { selected } = await dshSession.selectModel(sessionId, groupId, modelId);
      setModels(prev => (prev ? { ...prev, current: selected } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return createPortal(
    <div
      ref={elementRef}
      className={`ai00-session-float no-penetrate${isDragging ? ' is-dragging' : ''}${activeResize ? ' is-resizing' : ''}`}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex: `calc(var(--z-chrome-overlay) + ${index})`,
      }}
      onMouseDown={handleMouseDown}
    >
      <div className="ai00-session-float__head">
        <GripHorizontal size={12} className="ai00-session-float__grip" />
        <span className={`ai00-session-float__dot${agentRunning ? ' is-running' : ''}`} />
        <span className="ai00-session-float__title" title={info.taskLabel}>
          {info.taskLabel || t('chat.title')}
        </span>
        <button
          type="button"
          className="ai00-session-float__close"
          onClick={onClose}
          aria-label={t('card.close')}
        >
          <X size={12} />
        </button>
      </div>

      <div className="ai00-session-float__chat" onMouseDown={e => e.stopPropagation()}>
        <div className="ai00-x-dsh-scene__messages" ref={bodyRef}>
          {loading && (
            <div className="ai00-x-dsh-scene__messages-empty">{tDsh('sessions.loading')}</div>
          )}
          {!loading && messages.length === 0 && !error && (
            <div className="ai00-x-dsh-scene__messages-empty">{tDsh('chat.empty')}</div>
          )}
          {messages.map(m => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {error && <div className="ai00-x-dsh-scene__error">{error}</div>}
        </div>

        {approvals.length > 0 && (
          <div className="ai00-x-dsh-scene__approvals">
            {approvals.map(a => (
              <ApprovalCard
                key={a.rpcId}
                approval={a}
                onRespond={(rpcId, outcome) => void respondApproval(rpcId, outcome)}
              />
            ))}
          </div>
        )}
        {questions.length > 0 && (
          <div className="ai00-x-dsh-scene__approvals">
            {questions.map(q => (
              <QuestionCard key={q.rpcId} batch={q} onRespond={respondQuestion} onCancel={cancelQuestion} />
            ))}
          </div>
        )}

        {/* 标准对话输入框（design-system PromptInput + ModelSelector，同 DshScene） */}
        <div className="ai00-x-dsh-scene__composer">
          <PromptInput
            value={draft}
            onChange={setDraft}
            onSubmit={() => void handleSend()}
            onStop={() => void handleStop()}
            loading={sending}
            placeholder={tDsh('chat.inputPlaceholder')}
            footerLeft={
              <ModelSelector
                groups={(models?.groups ?? []).map(g => ({
                  id: g.id,
                  name: g.name,
                  models: g.models.map(m => ({
                    id: m.id,
                    name: m.name,
                    description: m.description,
                  })),
                }))}
                currentId={models?.current.model ?? null}
                onSelect={(groupId, modelId) => void handleSelectModel(groupId, modelId)}
                loading={!models}
              />
            }
          />
        </div>
      </div>

      {/* 8 向 resize 手柄（4 边 + 4 角，MusicPopup 模式） */}
      <div className="ai00-session-float__resize ai00-session-float__resize--n" onMouseDown={handleResizeMouseDown('n')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--s" onMouseDown={handleResizeMouseDown('s')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--e" onMouseDown={handleResizeMouseDown('e')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--w" onMouseDown={handleResizeMouseDown('w')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--ne" onMouseDown={handleResizeMouseDown('ne')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--nw" onMouseDown={handleResizeMouseDown('nw')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--se" onMouseDown={handleResizeMouseDown('se')} />
      <div className="ai00-session-float__resize ai00-session-float__resize--sw" onMouseDown={handleResizeMouseDown('sw')} />
    </div>,
    document.body,
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  GitFork,
  HelpCircle,
  Pencil,
  Plus,
  RefreshCw,
  ShieldQuestion,
  X,
  Zap,
} from 'lucide-react';
import { Button, ModelSelector, PromptInput } from '@/component-library';
import { useNotification } from '@/shared/notification-system';
import { createConfigCenterTab } from '@/shared/utils/tabUtils';
import { dshPlugins } from '@/infrastructure/api/service-api/DshAPI';
import { useDshChat } from './hooks/useDshChat';
import { MessageBubble } from './DshChatPieces';
import { ImpVisual } from '@/app/components/AgentTheater/ImpVisual';
import { useTheaterStore } from '@/app/components/AgentTheater/theaterStore';
import { consumePendingDshSession } from '@/app/components/AgentTheater/dshNav';
import { Sparkles } from 'lucide-react';
import type {
  DshApproval,
  DshPermissionRequest,
  DshQuestion,
  DshQuestionAnswerItem,
} from '@/infrastructure/api/service-api/DshAPI';
import './DshScene.scss';


/** 待处理审批卡片（工具执行确认）。 */
const ApprovalCard: React.FC<{
  approval: DshApproval;
  onRespond: (rpcId: string, outcome: 'allowed-once' | 'rejected') => void;
}> = ({ approval, onRespond }) => {
  const { t } = useTranslation('scenes/dsh');
  return (
    <div className="ai00-x-dsh-scene__approval">
      <div className="ai00-x-dsh-scene__approval-head">
        <ShieldQuestion size={14} />
        <span className="ai00-x-dsh-scene__approval-tool">{approval.toolName}</span>
        <span className="ai00-x-dsh-scene__approval-label">{t('approval.pending')}</span>
      </div>
      {approval.reason && (
        <p className="ai00-x-dsh-scene__approval-reason">{approval.reason}</p>
      )}
      <div className="ai00-x-dsh-scene__approval-actions">
        <Button
          variant="primary"
          size="small"
          onClick={() => onRespond(approval.rpcId, 'allowed-once')}
        >
          {t('approval.allow')}
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => onRespond(approval.rpcId, 'rejected')}
        >
          {t('approval.reject')}
        </Button>
      </div>
    </div>
  );
};

/** 插件 scope 授权卡（per-plugin 权限模型 v1：403 归因 → 一键授予）。 */
const PermissionCard: React.FC<{
  request: DshPermissionRequest;
  onGrant: (request: DshPermissionRequest) => void;
  onDismiss: (request: DshPermissionRequest) => void;
}> = ({ request, onGrant, onDismiss }) => {
  const { t } = useTranslation('scenes/dsh');
  return (
    <div className="ai00-x-dsh-scene__approval">
      <div className="ai00-x-dsh-scene__approval-head">
        <ShieldQuestion size={14} />
        <span className="ai00-x-dsh-scene__approval-tool">{request.pluginId}</span>
        <span className="ai00-x-dsh-scene__approval-label">
          {t('permission.pending', { scope: request.scope })}
        </span>
      </div>
      <p className="ai00-x-dsh-scene__approval-reason">
        {t('permission.reason', { scope: request.scope })}
      </p>
      <div className="ai00-x-dsh-scene__approval-actions">
        <Button variant="primary" size="small" onClick={() => onGrant(request)}>
          {t('permission.grant')}
        </Button>
        <Button variant="secondary" size="small" onClick={() => onDismiss(request)}>
          {t('permission.deny')}
        </Button>
      </div>
    </div>
  );
};

/** 单个问题的作答区（选项按钮 + 自定义输入）。 */
const QuestionItemForm: React.FC<{
  question: DshQuestion['questions'][number];
  value: { selected: string[]; custom: string };
  onChange: (v: { selected: string[]; custom: string }) => void;
}> = ({ question, value, onChange }) => {
  const { t } = useTranslation('scenes/dsh');
  const multi = question.multiSelect === true;

  const toggleOption = (label: string) => {
    if (multi) {
      const selected = value.selected.includes(label)
        ? value.selected.filter(l => l !== label)
        : [...value.selected, label];
      onChange({ selected, custom: '' });
    } else {
      // 单选：选中即清空 custom（契约：互斥）
      onChange({ selected: [label], custom: '' });
    }
  };

  const setCustom = (custom: string) => {
    // 填 custom 即清空 selected（契约：互斥）
    onChange({ selected: custom ? [] : value.selected, custom });
  };

  return (
    <div className="ai00-x-dsh-scene__q-item">
      <div className="ai00-x-dsh-scene__q-text">{question.question}</div>
      {question.detail && <p className="ai00-x-dsh-scene__q-detail">{question.detail}</p>}
      {question.options && question.options.length > 0 && (
        <div className={`ai00-x-dsh-scene__q-options${multi ? ' is-multi' : ''}`}>
          {question.options.map(opt => {
            const active = value.selected.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                className={`ai00-x-dsh-scene__q-option${active ? ' is-active' : ''}`}
                onClick={() => toggleOption(opt.label)}
                title={opt.description}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
      <input
        type="text"
        className="ai00-x-dsh-scene__q-custom"
        placeholder={t('question.customPlaceholder')}
        value={value.custom}
        onChange={e => setCustom(e.target.value)}
      />
    </div>
  );
};

/** 待处理问题批次卡片（ask_user_question 应答）。 */
const QuestionCard: React.FC<{
  batch: DshQuestion;
  onRespond: (rpcId: string, answers: DshQuestionAnswerItem[]) => void;
  onCancel: (rpcId: string) => void;
}> = ({ batch, onRespond, onCancel }) => {
  const { t } = useTranslation('scenes/dsh');
  /** 每个问题的草稿作答。 */
  const [drafts, setDrafts] = useState<Record<string, { selected: string[]; custom: string }>>(
    () =>
      Object.fromEntries(
        batch.questions.map(q => [q.id, { selected: [] as string[], custom: '' }]),
      ),
  );

  const canSubmit = batch.questions.every(q => {
    const d = drafts[q.id];
    return !!d && (d.selected.length > 0 || d.custom.trim().length > 0);
  });

  const submit = () => {
    const answers: DshQuestionAnswerItem[] = batch.questions.map(q => {
      const d = drafts[q.id];
      const custom = d.custom.trim();
      return {
        id: q.id,
        selected: custom ? [] : d.selected,
        ...(custom ? { custom } : {}),
      };
    });
    onRespond(batch.rpcId, answers);
  };

  return (
    <div className="ai00-x-dsh-scene__question">
      <div className="ai00-x-dsh-scene__q-head">
        <HelpCircle size={14} />
        <span className="ai00-x-dsh-scene__q-head-label">{t('question.pending')}</span>
        <button
          type="button"
          className="ai00-x-dsh-scene__q-cancel"
          onClick={() => onCancel(batch.rpcId)}
          aria-label={t('question.cancel')}
        >
          <X size={12} />
        </button>
      </div>
      {batch.questions.map(q => (
        <QuestionItemForm
          key={q.id}
          question={q}
          value={drafts[q.id] ?? { selected: [], custom: '' }}
          onChange={v => setDrafts(prev => ({ ...prev, [q.id]: v }))}
        />
      ))}
      <div className="ai00-x-dsh-scene__q-actions">
        <Button variant="primary" size="small" onClick={submit} disabled={!canSubmit}>
          {t('question.submit')}
        </Button>
      </div>
    </div>
  );
};

/** dsh Agent 场景：自有 UI 直连 dsh sidecar（不用 dsh 自带 Web UI）。 */
const DshScene: React.FC = () => {
  const { t } = useTranslation('scenes/dsh');
  const notification = useNotification();
  const {
    phase,
    wsConnected,
    sessions,
    sessionsLoading,
    currentSessionId,
    messages,
    sending,
    error,
    approvals,
    questions,
    models,
    pluginError,
    permissionRequests,
    usage,
    openSession,
    newSession,
    send,
    stop,
    refreshSessions,
    respondApproval,
    respondQuestion,
    cancelQuestion,
    selectModel,
    renameSession,
    forkSession,
    restartEngine,
    grantPermission,
    dismissPermission,
    clearPluginError,
  } = useDshChat();

  // 工灵剧场（AgentTheater）：开关 + 会话卡片点击联动（设计 §3.5）
  const theaterEnabled = useTheaterStore((st) => st.enabled);
  const setTheaterEnabled = useTheaterStore((st) => st.setEnabled);
  const openChatPanel = useTheaterStore((st) => st.openChatPanel);

  // 外部唤起：AgentCard「打开会话」/ 其他入口 → 选中并打开会话
  useEffect(() => {
    const onOpenSession = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      const sid = detail?.sessionId;
      if (sid) void openSession(sid);
    };
    window.addEventListener('dsh:open-session', onOpenSession);
    // 跨懒加载边界：AgentCard 先记 pending 再开场景，此处挂载即取走
    const pending = consumePendingDshSession();
    if (pending) void openSession(pending);
    return () => window.removeEventListener('dsh:open-session', onOpenSession);
  }, [openSession]);

  /** 一键停用归因插件的进行中标记。 */
  const [disablingPlugin, setDisablingPlugin] = useState(false);
  /** 会话重命名的行内编辑态。 */
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  /** fork 进行中标记（当前会话）。 */
  const [forking, setForking] = useState(false);

  const submitRename = () => {
    if (!currentSessionId) return;
    const title = renameDraft.trim();
    setRenaming(false);
    if (title) void renameSession(currentSessionId, title);
  };

  const startRename = (currentTitle: string) => {
    setRenameDraft(currentTitle);
    setRenaming(true);
  };

  const handleFork = async () => {
    if (!currentSessionId || forking) return;
    try {
      setForking(true);
      await forkSession(currentSessionId);
    } finally {
      setForking(false);
    }
  };

  /** 用量摘要（M2.2）：紧凑格式化 tokens。 */
  const usageLabel: string | null = (() => {
    if (!usage) return null;
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return `↑${fmt(usage.inputTokens)} ↓${fmt(usage.outputTokens)} · ${usage.requests}`;
  })();

  /** 一键停用：停掉归因插件（bundles 摘除 + 引擎重启），成功后清横幅。 */
  const handleDisablePlugin = async () => {
    if (!pluginError?.module || disablingPlugin) return;
    try {
      setDisablingPlugin(true);
      await dshPlugins.setEnabled(pluginError.module, false);
      notification.success(t('pluginErrorDisabled', { module: pluginError.module }));
      clearPluginError();
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDisablingPlugin(false);
    }
  };

  /** 直达设置页 DSH 插件 tab，并请求高亮归因插件行。 */
  const handleGoPluginSettings = () => {
    createConfigCenterTab('dsh-plugins');
    window.dispatchEvent(
      new CustomEvent('dsh-plugin-highlight', { detail: pluginError?.module ?? null }),
    );
    clearPluginError();
  };

  const currentApprovals = approvals.filter(a => a.sessionId === currentSessionId);
  const currentQuestions = questions.filter(q => q.sessionId === currentSessionId);

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    send(text);
  };

  const phaseLabel = (() => {
    switch (phase?.phase) {
      case 'installing':
        return t('status.installing', { stage: phase.stage ?? '' });
      case 'failed':
        return t('status.failed', { error: phase.error ?? '' });
      case 'running':
        return t('status.running');
      case 'ready':
        return t('status.ready');
      default:
        return t('status.starting');
    }
  })();

  return (
    <div className="ai00-x-dsh-scene">
      {pluginError && (
        <div className="ai00-x-dsh-scene__plugin-error" title={pluginError.raw}>
          <div className="ai00-x-dsh-scene__plugin-error-main">
            <span>{t('pluginError')}</span>
            {pluginError.module && (
              <span className="ai00-x-dsh-scene__plugin-error-module">
                {t('pluginErrorAttributed', { module: pluginError.module })}
              </span>
            )}
            <code>{pluginError.raw.slice(0, 200)}</code>
          </div>
          <div className="ai00-x-dsh-scene__plugin-error-actions">
            {pluginError.module && (
              <Button
                variant="secondary"
                size="small"
                disabled={disablingPlugin}
                onClick={handleDisablePlugin}
              >
                {t('pluginErrorDisable', { module: pluginError.module })}
              </Button>
            )}
            <Button variant="ghost" size="small" onClick={handleGoPluginSettings}>
              {t('pluginErrorGoSettings')}
            </Button>
            <button
              type="button"
              className="ai00-x-dsh-scene__plugin-error-close"
              aria-label={t('pluginErrorClose')}
              onClick={clearPluginError}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      {permissionRequests.length > 0 && (
        <div className="ai00-x-dsh-scene__approvals">
          {permissionRequests.map(request => (
            <PermissionCard
              key={`${request.pluginId}:${request.scope}`}
              request={request}
              onGrant={grantPermission}
              onDismiss={dismissPermission}
            />
          ))}
        </div>
      )}
      <aside className="ai00-x-dsh-scene__sidebar">
        <div className="ai00-x-dsh-scene__sidebar-header">
          <span className="ai00-x-dsh-scene__sidebar-title">{t('sessions.title')}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Button
              variant="ghost"
              size="small"
              onClick={() => setTheaterEnabled(!theaterEnabled)}
              aria-label={theaterEnabled ? t('theater.disable') : t('theater.enable')}
              title={theaterEnabled ? t('theater.disable') : t('theater.enable')}
              className={theaterEnabled ? 'ai00-x-dsh-scene__theater-toggle is-on' : 'ai00-x-dsh-scene__theater-toggle'}
            >
              <Sparkles size={14} />
            </Button>
            <Button variant="ghost" size="small" onClick={newSession} aria-label={t('sessions.new')}>
              <Plus size={14} />
            </Button>
          </span>
        </div>
        <div className="ai00-x-dsh-scene__session-list">
          {sessionsLoading && (
            <div className="ai00-x-dsh-scene__session-empty">{t('sessions.loading')}</div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <div className="ai00-x-dsh-scene__session-empty">{t('sessions.empty')}</div>
          )}
          {sessions.map(s => {
            const title = s.projections?.values?.title ?? s.sessionId.slice(8, 16);
            const isActive = s.sessionId === currentSessionId;
            return (
              <button
                key={s.sessionId}
                type="button"
                className={`ai00-x-dsh-scene__session-item${isActive ? ' is-active' : ''}`}
                onClick={() => openSession(s.sessionId)}
              >
                {isActive && renaming ? (
                  <input
                    type="text"
                    className="ai00-x-dsh-scene__session-rename"
                    value={renameDraft}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                    onChange={e => setRenameDraft(e.target.value)}
                    onBlur={submitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submitRename();
                      if (e.key === 'Escape') setRenaming(false);
                    }}
                  />
                ) : (
                  <span className="ai00-x-dsh-scene__session-name">{title}</span>
                )}
                <span className="ai00-x-dsh-scene__session-meta">
                  {s.running && theaterEnabled && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="ai00-x-dsh-scene__session-imp"
                      title={t('theater.openCard')}
                      onClick={(e) => {
                        e.stopPropagation();
                        openChatPanel(s.sessionId, title);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          openChatPanel(s.sessionId, title);
                        }
                      }}
                    >
                      <ImpVisual sessionId={s.sessionId} category="general" size={16} />
                    </span>
                  )}
                  {s.running && <span className="ai00-x-dsh-scene__dot" />}
                  {new Date(s.updatedAt).toLocaleTimeString()}
                </span>
                {isActive && !renaming && (
                  <span className="ai00-x-dsh-scene__session-actions">
                    <span
                      role="button"
                      tabIndex={0}
                      className="ai00-x-dsh-scene__session-action"
                      title={t('sessions.rename')}
                      onClick={e => {
                        e.stopPropagation();
                        startRename(title);
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          startRename(title);
                        }
                      }}
                    >
                      <Pencil size={11} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="ai00-x-dsh-scene__session-action"
                      title={t('sessions.fork')}
                      onClick={e => {
                        e.stopPropagation();
                        void handleFork();
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          void handleFork();
                        }
                      }}
                    >
                      <GitFork size={11} />
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="ai00-x-dsh-scene__sidebar-footer">
          <span
            className={`ai00-x-dsh-scene__ws-dot${wsConnected ? ' is-on' : ''}`}
            title={wsConnected ? t('status.wsOn') : t('status.wsOff')}
          />
          <span className="ai00-x-dsh-scene__phase">{phaseLabel}</span>
          {usageLabel && (
            <span className="ai00-x-dsh-scene__usage" title={t('sessions.usage')}>
              <Zap size={10} />
              {usageLabel}
            </span>
          )}
          {phase?.phase === 'failed' && (
            <Button
              variant="ghost"
              size="small"
              onClick={() => void restartEngine()}
              aria-label={t('status.restart')}
              title={t('status.restart')}
            >
              <RefreshCw size={12} />
            </Button>
          )}
          <Button variant="ghost" size="small" onClick={refreshSessions} aria-label={t('sessions.refresh')}>
            <RefreshCw size={12} />
          </Button>
        </div>
      </aside>

      <section className="ai00-x-dsh-scene__main">
        {!currentSessionId ? (
          <div className="ai00-x-dsh-scene__placeholder">
            <Bot size={32} />
            <p>{t('chat.placeholder')}</p>
            <Button variant="primary" size="small" onClick={newSession}>
              <Plus size={14} />
              {t('sessions.new')}
            </Button>
          </div>
        ) : (
          <>
            <div className="ai00-x-dsh-scene__messages" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="ai00-x-dsh-scene__messages-empty">{t('chat.empty')}</div>
              )}
              {messages.map(m => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </div>
            {currentApprovals.length > 0 && (
              <div className="ai00-x-dsh-scene__approvals">
                {currentApprovals.map(a => (
                  <ApprovalCard key={a.rpcId} approval={a} onRespond={respondApproval} />
                ))}
              </div>
            )}
            {currentQuestions.length > 0 && (
              <div className="ai00-x-dsh-scene__approvals">
                {currentQuestions.map(q => (
                  <QuestionCard
                    key={q.rpcId}
                    batch={q}
                    onRespond={respondQuestion}
                    onCancel={cancelQuestion}
                  />
                ))}
              </div>
            )}
            {error && <div className="ai00-x-dsh-scene__error">{error}</div>}
            {/* 标准对话输入框（design-system PromptInput + ModelSelector） */}
            <div className="ai00-x-dsh-scene__composer">
              <PromptInput
                value={input}
                onChange={setInput}
                onSubmit={handleSend}
                onStop={stop}
                loading={sending}
                placeholder={t('chat.inputPlaceholder')}
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
                    onSelect={(groupId, modelId) => selectModel(groupId, modelId)}
                    loading={!models}
                  />
                }
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default DshScene;

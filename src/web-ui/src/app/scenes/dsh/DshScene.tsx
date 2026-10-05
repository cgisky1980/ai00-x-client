import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  GitFork,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  X,
  Zap,
} from 'lucide-react';
import { Button, Modal, ModelSelector, PromptInput } from '@/component-library';
import { useNotification } from '@/shared/notification-system';
import { createConfigCenterTab } from '@/shared/utils/tabUtils';
import {
  dshCommands,
  dshPermission,
  dshPlugins,
  dshSnapshots,
  formatCacheHitRate,
  type DshCommandInfo,
  type DshSnapshotEntry,
} from '@/infrastructure/api/service-api/DshAPI';
import { useWorkspaceManagerSync } from '@/infrastructure/hooks/useWorkspaceManagerSync';
import { useDshChat } from './hooks/useDshChat';
import {
  ApprovalCard,
  MessageBubble,
  PermissionCard,
  QuestionCard,
} from './DshChatPieces';
import { ImpVisual } from '@/app/components/AgentTheater/ImpVisual';
import { useTheaterStore } from '@/app/components/AgentTheater/theaterStore';
import { consumePendingDshSession } from '@/app/components/AgentTheater/dshNav';
import { Sparkles } from 'lucide-react';
import './DshScene.scss';


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
    jobsBySession,
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

  // ---- 后台作业（session/control jobs 帧：子代理/工作流等后台执行单元） ----
  const runningJobs = useMemo(() => {
    const list = jobsBySession[currentSessionId ?? '*'] ?? [];
    return list.filter(j => !j.finishedAt && !['done', 'completed', 'failed', 'cancelled'].includes(j.status));
  }, [jobsBySession, currentSessionId]);

  // ---- 快照时间线（当前工作区；agent 签名快照） ----
  const { workspacePath, hasWorkspace } = useWorkspaceManagerSync();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<DshSnapshotEntry[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<DshSnapshotEntry | null>(null);

  const loadSnapshots = useCallback(async () => {
    if (!workspacePath) return;
    try {
      setSnapshotsLoading(true);
      setSnapshots(await dshSnapshots.list(workspacePath, 100));
    } catch {
      // 无 git 历史/目录不可读 → 空时间线
      setSnapshots([]);
    } finally {
      setSnapshotsLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (snapshotsOpen) void loadSnapshots();
  }, [snapshotsOpen, loadSnapshots]);

  const handleSnapshotNow = async (): Promise<void> => {
    if (!workspacePath || snapBusy) return;
    try {
      setSnapBusy(true);
      const result = await dshSnapshots.now(workspacePath);
      notification.success(
        result.commit
          ? t('snapshots.taken', { commit: result.commit.slice(0, 8) })
          : t('snapshots.noChanges'),
      );
      await loadSnapshots();
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSnapBusy(false);
    }
  };

  const handleRollback = async (): Promise<void> => {
    if (!workspacePath || !rollbackTarget || snapBusy) return;
    try {
      setSnapBusy(true);
      await dshSnapshots.rollback(workspacePath, rollbackTarget.commit);
      notification.success(t('snapshots.rolledBack', { commit: rollbackTarget.commit.slice(0, 8) }));
      setRollbackTarget(null);
      await loadSnapshots();
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSnapBusy(false);
    }
  };

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

  /** 用量摘要（M2.2）：紧凑格式化 tokens；R2-8 追加缓存命中率（未上报则不显示）。 */
  const usageLabel: string | null = (() => {
    if (!usage) return null;
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const cacheRate = formatCacheHitRate(usage);
    return [
      `↑${fmt(usage.inputTokens)} ↓${fmt(usage.outputTokens)} · ${usage.requests}`,
      cacheRate ? `${t('sessions.cacheHit')} ${cacheRate}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
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

  /** exit_plan_mode 审批卡的计划正文（从会话里匹配 callId 的工具调用参数提取）。 */
  const planTextFor = (callId?: string): string | undefined => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const tc of messages[i].toolCalls) {
        if (tc.name !== 'exit_plan_mode') continue;
        if (callId && tc.id !== callId) continue;
        try {
          const args = JSON.parse(tc.arguments) as { plan?: unknown };
          if (typeof args?.plan === 'string' && args.plan.trim()) return args.plan;
        } catch {
          // 参数非 JSON 时回退 reason 文本
        }
      }
    }
    return undefined;
  };

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // ---- Slash 命令（commands/list + commands/execute；plan mode 等经此驱动）----
  const [commands, setCommands] = useState<DshCommandInfo[]>([]);

  // 会话切换后拉命令目录（引擎可能未就绪/版本不支持 → 静默失败，面板退化为纯文本输入）
  useEffect(() => {
    if (!currentSessionId) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    dshCommands.list(currentSessionId).then(
      list => {
        if (!cancelled) setCommands(list);
      },
      () => {
        if (!cancelled) setCommands([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  /** 输入以 / 开头时给出候选面板（首个 token 前缀过滤）。 */
  const commandSuggestions = (() => {
    if (!input.startsWith('/') || input.includes('\n') || commands.length === 0) return [];
    const token = input.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? '';
    return commands.filter(cmd => cmd.name.startsWith(token));
  })();

  const executeCommand = async (line: string): Promise<void> => {
    if (!currentSessionId) return;
    try {
      const settled = await dshCommands.execute(currentSessionId, line);
      const result = settled?.result;
      if (!settled || !result) {
        notification.warning(t('command.unknown', { line }));
      } else if (result.kind === 'error') {
        notification.error(result.text);
      } else if (result.text) {
        notification.success(result.text);
      }
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    // 斜杠行走引擎命令通道（不产生模型消息）；其余进会话
    if (text.startsWith('/')) {
      void executeCommand(text);
      return;
    }
    send(text);
  };

  const handleSuggestionPick = (cmd: DshCommandInfo) => {
    // 带 input 提示的命令（如 /plan <message>）回填编辑框让用户补参数；裸命令直接执行
    if (cmd.input?.hint) {
      setInput(`/${cmd.name} `);
      return;
    }
    setInput('');
    void executeCommand(`/${cmd.name}`);
  };

  // ---- 权限档（DSH_PERMISSION_MODE；重启引擎生效）----
  const [permMode, setPermMode] = useState<string>('');
  useEffect(() => {
    dshPermission.get().then(
      mode => setPermMode(mode ?? ''),
      () => {},
    );
  }, []);
  const handlePermModeChange = async (mode: string): Promise<void> => {
    setPermMode(mode);
    try {
      await dshPermission.set(mode || null);
      notification.info(mode ? t('permMode.saved', { mode }) : t('permMode.savedDefault'));
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    }
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
              onClick={() => setSnapshotsOpen(true)}
              aria-label={t('snapshots.title')}
              title={t('snapshots.title')}
              disabled={!hasWorkspace}
            >
              <History size={14} />
            </Button>
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
          <select
            className="ai00-x-dsh-scene__perm-select"
            value={permMode}
            title={t('permMode.title')}
            aria-label={t('permMode.title')}
            onChange={e => void handlePermModeChange(e.target.value)}
          >
            <option value="">{t('permMode.default')}</option>
            <option value="read-only">{t('permMode.readOnly')}</option>
            <option value="workspace-write">{t('permMode.workspaceWrite')}</option>
            <option value="danger-full-access">{t('permMode.dangerFull')}</option>
          </select>
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
                  <ApprovalCard
                    key={a.rpcId}
                    approval={a}
                    onRespond={respondApproval}
                    planText={a.toolName === 'exit_plan_mode' ? planTextFor(a.callId) : undefined}
                  />
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
            {runningJobs.length > 0 && (
              <div className="ai00-x-dsh-scene__jobs">
                {runningJobs.map(job => (
                  <span key={job.id} className="ai00-x-dsh-scene__job" title={job.id}>
                    <Loader2 size={11} className="ai00-x-dsh-scene__job-spin" />
                    {job.label || job.kind || job.id.slice(0, 8)}
                  </span>
                ))}
              </div>
            )}
            {error && <div className="ai00-x-dsh-scene__error">{error}</div>}
            {commandSuggestions.length > 0 && (
              <div className="ai00-x-dsh-scene__command-palette" role="listbox">
                {commandSuggestions.map(cmd => (
                  <button
                    key={cmd.name}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="ai00-x-dsh-scene__command-item"
                    onClick={() => handleSuggestionPick(cmd)}
                  >
                    <span className="ai00-x-dsh-scene__command-name">
                      /{cmd.name}
                      {cmd.input?.hint && (
                        <span className="ai00-x-dsh-scene__command-hint"> {cmd.input.hint}</span>
                      )}
                    </span>
                    <span className="ai00-x-dsh-scene__command-desc">{cmd.description}</span>
                  </button>
                ))}
              </div>
            )}
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

      <Modal
        isOpen={snapshotsOpen}
        onClose={() => setSnapshotsOpen(false)}
        title={t('snapshots.title')}
      >
        <div className="ai00-x-dsh-scene__snapshots">
          {!hasWorkspace && <p className="ai00-x-dsh-scene__snapshots-hint">{t('snapshots.noWorkspace')}</p>}
          {hasWorkspace && snapshotsLoading && (
            <p className="ai00-x-dsh-scene__snapshots-hint">{t('snapshots.loading')}</p>
          )}
          {hasWorkspace && !snapshotsLoading && snapshots.length === 0 && (
            <p className="ai00-x-dsh-scene__snapshots-hint">{t('snapshots.empty')}</p>
          )}
          {hasWorkspace &&
            snapshots.map(snap => (
              <div key={snap.commit} className="ai00-x-dsh-scene__snapshot">
                <div className="ai00-x-dsh-scene__snapshot-main">
                  <code className="ai00-x-dsh-scene__snapshot-hash">{snap.commit.slice(0, 8)}</code>
                  <span className="ai00-x-dsh-scene__snapshot-msg">{snap.message}</span>
                  <span className="ai00-x-dsh-scene__snapshot-time">
                    {new Date(snap.time * 1000).toLocaleString()}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={snapBusy}
                  onClick={() => setRollbackTarget(snap)}
                >
                  {t('snapshots.rollback')}
                </Button>
              </div>
            ))}
          <div className="ai00-x-dsh-scene__modal-actions">
            <Button variant="secondary" size="small" onClick={() => void loadSnapshots()}>
              <RefreshCw size={13} />
              {t('snapshots.refresh')}
            </Button>
            <Button
              variant="primary"
              size="small"
              disabled={snapBusy || !hasWorkspace}
              onClick={() => void handleSnapshotNow()}
            >
              <Plus size={13} />
              {t('snapshots.now')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={rollbackTarget !== null}
        onClose={() => setRollbackTarget(null)}
        title={t('snapshots.rollbackTitle', { commit: rollbackTarget?.commit.slice(0, 8) ?? '' })}
      >
        <p className="ai00-x-dsh-scene__snapshots-hint">{t('snapshots.rollbackWarn')}</p>
        <div className="ai00-x-dsh-scene__modal-actions">
          <Button variant="secondary" size="small" onClick={() => setRollbackTarget(null)}>
            {t('snapshots.cancel')}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={snapBusy}
            onClick={() => void handleRollback()}
          >
            {t('snapshots.rollbackConfirm')}
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default DshScene;

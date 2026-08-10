/** Optimized viewer/editor for `PLAN.md` files (frontmatter + markdown body). */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Circle, ArrowRight, Check, XCircle, Loader2, CheckCircle, AlertCircle, FileText, Pencil, X, ChevronDown, Trash2, Plus } from 'lucide-react';
import yaml from 'yaml';
import { MEditor } from '../meditor';
import type { EditorInstance } from '../meditor';
import { createLogger } from '@/shared/utils/logger';
import { CubeLoading, Button, Tooltip } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { useTheme } from '@/infrastructure/theme/hooks/useTheme';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { fileSystemService } from '@/tools/file-system/services/FileSystemService';
import { planBuildStateService } from '@/shared/services/PlanBuildStateService';
import { globalEventBus } from '@/infrastructure/event-bus';
import { basenamePath, dirnameAbsolutePath } from '@/shared/utils/pathUtils';
import { useActiveSession } from '@/flow_chat/store/modernFlowChatStore';
import { FlowChatStore } from '@/flow_chat/store/FlowChatStore';
import { syncSessionToModernStore } from '@/flow_chat/services/storeSync';
import './PlanViewer.scss';

const log = createLogger('PlanViewer');

// Styles used by markdown rendering (math + code highlight).
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

interface PlanTodo {
  id: string;
  content: string;
  status?: string;
  dependencies?: string[];
}

interface PlanData {
  name: string;
  overview: string;
  todos: PlanTodo[];
}

export interface PlanViewerProps {
  /** File path */
  filePath: string;
  /** Workspace path */
  workspacePath?: string;
  /** File name */
  fileName?: string;
  /** Jump to specified line number */
  jumpToLine?: number;
  /** Jump to specified column number */
  jumpToColumn?: number;
}

const PlanViewer: React.FC<PlanViewerProps> = ({
  filePath,
  workspacePath,
  fileName,
  jumpToLine: _jumpToLine,
  jumpToColumn: _jumpToColumn,
}) => {
  const { t } = useI18n('tools');
  const { isLight } = useTheme();
  const mEditorTheme = isLight ? 'light' : 'dark';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData | null>(null);
  const [planContent, setPlanContent] = useState<string>('');
  // Initialize build state from the shared service to survive unmounts.
  const [isBuildStarted, setIsBuildStarted] = useState(() => {
    return filePath ? planBuildStateService.isBuildActive(filePath) : false;
  });
  const [originalContent, setOriginalContent] = useState('');
  // Todos list expand/collapse state (collapsed by default)
  const [isTodosExpanded, setIsTodosExpanded] = useState(true);
  const [isInlineTodoEditing, setIsInlineTodoEditing] = useState(false);
  const [inlineTodoDrafts, setInlineTodoDrafts] = useState<Record<string, string>>({});
  const [inlineDeletedTodoKeys, setInlineDeletedTodoKeys] = useState<string[]>([]);
  const [inlineAddedTodos, setInlineAddedTodos] = useState<PlanTodo[]>([]);

  const editorRef = useRef<EditorInstance>(null);
  const isUnmountedRef = useRef(false);
  const needsContentSyncRef = useRef(false);

  const basePath = useMemo(() => {
    if (!filePath) return undefined;
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    if (lastSlashIndex >= 0) {
      return normalizedPath.substring(0, lastSlashIndex);
    }
    return undefined;
  }, [filePath]);

  const displayFileName = useMemo(() => {
    if (fileName) return fileName;
    return basenamePath(filePath);
  }, [filePath, fileName]);

  const hasTodos = !!(planData?.todos && planData.todos.length > 0);

  useEffect(() => {
    isUnmountedRef.current = false;
    const editor = editorRef.current;
    return () => {
      isUnmountedRef.current = true;
      editor?.destroy();
    };
  }, []);

  const loadFileContent = useCallback(async () => {
    if (!filePath || isUnmountedRef.current) {
      if (!isUnmountedRef.current) setLoading(false);
      return;
    }

    if (planBuildStateService.isFileWriting(filePath)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const content = await workspaceAPI.readFileContent(filePath);

      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const rawYaml = frontmatterMatch[1];
        const parsed = yaml.parse(rawYaml);
        const markdownContent = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();

        if (!isUnmountedRef.current) {
          setPlanData({
            name: parsed.name || '',
            overview: parsed.overview || '',
            todos: parsed.todos || [],
          });
          setPlanContent(markdownContent);
          setOriginalContent(markdownContent);
          needsContentSyncRef.current = true;
        }
      } else {
        if (!isUnmountedRef.current) {
          setPlanData(null);
          setPlanContent(content);
          setOriginalContent(content);
          needsContentSyncRef.current = true;
        }
      }
    } catch (err) {
      if (!isUnmountedRef.current) {
        const errStr = String(err);
        log.error('Failed to load file', err);
        // Simplify error message
        let displayError = t('editor.common.loadFailed');
        if (errStr.includes('does not exist') || errStr.includes('No such file')) {
          displayError = t('editor.common.fileNotFound');
        } else if (errStr.includes('Permission denied') || errStr.includes('permission')) {
          displayError = t('editor.common.permissionDenied');
        }
        setError(displayError);
      }
    } finally {
      if (!isUnmountedRef.current) {
        setLoading(false);
      }
    }
  }, [filePath, t]);

  useEffect(() => {
    loadFileContent();
  }, [loadFileContent]);

  useEffect(() => {
    if (!filePath) return;

    const normalizedPlanPath = filePath.replace(/\\/g, '/');
    const dirPath = dirnameAbsolutePath(filePath);

    if (!dirPath) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unwatch = fileSystemService.watchFileChanges(dirPath, (event) => {
      const eventPath = event.path.replace(/\\/g, '/');
      if (eventPath !== normalizedPlanPath) return;
      if (event.type !== 'modified') return;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        loadFileContent();
      }, 300);
    });

    return () => {
      unwatch();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [filePath, loadFileContent]);

  // Subscribe to shared build state service for cross-component sync.
  useEffect(() => {
    if (!filePath) return;

    // Sync initial state (in case filePath just became available).
    setIsBuildStarted(planBuildStateService.isBuildActive(filePath));

    const unsubscribe = planBuildStateService.subscribe(filePath, (event) => {
      setIsBuildStarted(event.isBuilding);

      if (event.updatedTodos) {
        setPlanData(prev => prev ? { ...prev, todos: event.updatedTodos! } : null);
      }
    });

    return unsubscribe;
  }, [filePath]);

  const remainingTodos = useMemo(() => {
    if (!planData?.todos) return 0;
    return planData.todos.filter(t => t.status !== 'completed').length;
  }, [planData]);

  const buildStatus = useMemo((): 'build' | 'building' | 'built' => {
    if (planData?.todos?.length) {
      const statuses = planData.todos.map(t => t.status);
      if (statuses.every(s => s === 'completed')) {
        return 'built';
      }
    }
    if (isBuildStarted) {
      return 'building';
    }
    return 'build';
  }, [planData, isBuildStarted]);

  const activeSession = useActiveSession();
  const sessionId = activeSession?.sessionId ?? '';
  const workflowPhase = activeSession?.workflowPhase;

  const isPlanLocked = buildStatus === 'built' || isBuildStarted || workflowPhase === 'executing' || workflowPhase === 'reviewing';

  useEffect(() => {
    if (buildStatus === 'built' && isBuildStarted) {
      setIsBuildStarted(false);
    }
  }, [buildStatus, isBuildStarted]);

  const hasUnsavedChanges = useMemo(() => {
    return planContent !== originalContent;
  }, [planContent, originalContent]);

  const saveFileContent = useCallback(async () => {
    if (!hasUnsavedChanges || !filePath) return;

    try {
      const fullContent = planData
        ? `---\n${yaml.stringify({ name: planData.name, overview: planData.overview, todos: planData.todos })}\n---\n\n${planContent}`
        : planContent;

      await workspaceAPI.writeFileContent(workspacePath || '', filePath, fullContent);
      setOriginalContent(planContent);
      globalEventBus.emit('file-tree:refresh');
    } catch (err) {
      log.error('Failed to save file', err);
    }
  }, [planContent, filePath, workspacePath, hasUnsavedChanges, planData]);

  const handleContentChange = useCallback((newContent: string) => {
    setPlanContent(newContent);
    if (needsContentSyncRef.current) {
      needsContentSyncRef.current = false;
      setOriginalContent(newContent);
    }
  }, []);

  const handleSave = useCallback((_value: string) => {
    saveFileContent();
  }, [saveFileContent]);

  const buildTodoDraftsFromPlan = useCallback((todos: PlanTodo[]) => {
    const drafts: Record<string, string> = {};
    todos.forEach((todo, index) => {
      const key = todo.id || String(index);
      drafts[key] = todo.content;
    });
    return drafts;
  }, []);

  const startInlineTodoEdit = useCallback(() => {
    if (!planData?.todos?.length) return;
    setInlineTodoDrafts(buildTodoDraftsFromPlan(planData.todos));
    setInlineDeletedTodoKeys([]);
    setInlineAddedTodos([]);
    setIsInlineTodoEditing(true);
  }, [buildTodoDraftsFromPlan, planData]);

  const cancelInlineTodoEdit = useCallback(() => {
    setIsInlineTodoEditing(false);
    setInlineTodoDrafts({});
    setInlineDeletedTodoKeys([]);
    setInlineAddedTodos([]);
  }, []);

  const handleAddInlineTodo = useCallback(() => {
    const id = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newTodo: PlanTodo = { id, content: '', status: 'pending' };
    setInlineAddedTodos(prev => [...prev, newTodo]);
    setInlineTodoDrafts(prev => ({ ...prev, [id]: '' }));
  }, []);

  const handleDeleteInlineTodo = useCallback((todoKey: string) => {
    if (todoKey.startsWith('new-')) {
      setInlineAddedTodos(prev => prev.filter(todo => todo.id !== todoKey));
      setInlineTodoDrafts(prev => {
        const { [todoKey]: _removed, ...rest } = prev;
        return rest;
      });
      return;
    }
    setInlineDeletedTodoKeys(prev => (prev.includes(todoKey) ? prev : [...prev, todoKey]));
  }, []);

  const saveTodoEdits = useCallback(async (nextTodos: PlanTodo[]) => {
    if (!filePath || !planData) return;

    const updatedPlanData = { name: planData.name, overview: planData.overview, todos: nextTodos };
    const nextYamlContent = yaml.stringify(updatedPlanData).trimEnd();

    try {
      const fullContent = `---\n${nextYamlContent}\n---\n\n${planContent}`;
      await workspaceAPI.writeFileContent(workspacePath || '', filePath, fullContent);
      setPlanData(prev => (prev ? { ...prev, todos: nextTodos } : prev));
      setOriginalContent(planContent);
      globalEventBus.emit('file-tree:refresh');
    } catch (err) {
      log.error('Failed to save todo edit', err);
    }
  }, [filePath, planContent, planData, workspacePath]);

  const saveInlineTodoEdit = useCallback(async () => {
    if (!planData?.todos?.length) return;
    const nextTodos = planData.todos
      .map((todo, index) => ({ todo, key: todo.id || String(index) }))
      .filter(({ key }) => !inlineDeletedTodoKeys.includes(key))
      .map(({ todo, key }) => {
        const nextContent = (inlineTodoDrafts[key] ?? todo.content).trim();
        return { ...todo, content: nextContent || todo.content };
      })
      .concat(
        inlineAddedTodos
          .map(todo => ({ ...todo, content: (inlineTodoDrafts[todo.id] ?? todo.content).trim() }))
          .filter(todo => !!todo.content)
      );
    await saveTodoEdits(nextTodos);
    setIsInlineTodoEditing(false);
    setInlineTodoDrafts({});
    setInlineDeletedTodoKeys([]);
    setInlineAddedTodos([]);
  }, [inlineAddedTodos, inlineDeletedTodoKeys, inlineTodoDrafts, planData, saveTodoEdits]);

  const displayedInlineTodos = useMemo(() => {
    if (!planData?.todos) return [];
    if (!isInlineTodoEditing) return planData.todos;
    return [
      ...planData.todos.filter((todo, index) => !inlineDeletedTodoKeys.includes(todo.id || String(index))),
      ...inlineAddedTodos,
    ];
  }, [inlineAddedTodos, inlineDeletedTodoKeys, isInlineTodoEditing, planData]);

  const renderSharedTodoPanel = useCallback(() => {
    const panelClassName = `plan-viewer-todos ${isTodosExpanded ? 'plan-viewer-todos--expanded' : ''}`;
    const toolbarClassName = 'todo-inline-toolbar';

    return (
      <div className={panelClassName}>
        {!isPlanLocked && (
        <div className={toolbarClassName}>
          {isInlineTodoEditing ? (
            <>
              <Tooltip content={t('editor.common.add')} placement="top">
                <button
                  type="button"
                  className="edit-btn"
                  onClick={handleAddInlineTodo}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
              <Tooltip content={t('editor.common.save')} placement="top">
                <button
                  type="button"
                  className="edit-btn edit-btn--confirm"
                  onClick={saveInlineTodoEdit}
                >
                  <Check size={14} />
                </button>
              </Tooltip>
              <Tooltip content={t('editor.common.cancel')} placement="top">
                <button
                  type="button"
                  className="edit-btn"
                  onClick={cancelInlineTodoEdit}
                >
                  <X size={14} />
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip content={t('editor.common.edit')} placement="top">
              <button
                type="button"
                className="edit-btn"
                onClick={startInlineTodoEdit}
              >
                <Pencil size={14} />
              </button>
            </Tooltip>
          )}
        </div>
        )}

        <div className="todos-list">
          {displayedInlineTodos.map((todo, index) => (
            <div
              key={todo.id || index}
              className={`todo-item status-${todo.status || 'pending'}`}
            >
              {getTodoIcon(todo.status)}
              {isInlineTodoEditing ? (
                <>
                  <input
                    className="todo-content-input"
                    value={inlineTodoDrafts[todo.id || String(index)] ?? todo.content}
                    onChange={(e) => {
                      const key = todo.id || String(index);
                      setInlineTodoDrafts(prev => ({ ...prev, [key]: e.target.value }));
                    }}
                  />
                  <Tooltip content={t('editor.common.delete')} placement="top">
                    <button
                      type="button"
                      className="todo-delete-btn"
                      onClick={() => handleDeleteInlineTodo(todo.id || String(index))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                </>
              ) : (
                <span className="todo-content">{todo.content}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }, [
    cancelInlineTodoEdit,
    displayedInlineTodos,
    handleAddInlineTodo,
    handleDeleteInlineTodo,
    isInlineTodoEditing,
    isPlanLocked,
    isTodosExpanded,
    saveInlineTodoEdit,
    startInlineTodoEdit,
    t,
    inlineTodoDrafts,
  ]);

  const handleBuild = useCallback(async () => {
    if (!filePath || buildStatus !== 'build' || !planData || !sessionId) return;

    try {
      const legacyStore = FlowChatStore.getInstance();
      legacyStore.setPlanConfirmationNeeded(sessionId, filePath);
      syncSessionToModernStore(sessionId);

      await agentAPI.confirmPlan(sessionId);

      const content = await workspaceAPI.readFileContent(filePath);
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const parsed = yaml.parse(frontmatterMatch[1]);
        const fileTodoIds = (parsed.todos || planData.todos).map((t: any) => t.id);
        planBuildStateService.startBuild(filePath, fileTodoIds, sessionId);
      } else {
        const todoIds = planData.todos.map(t => t.id);
        planBuildStateService.startBuild(filePath, todoIds, sessionId);
      }
    } catch (err) {
      log.error('Build failed', err);
      planBuildStateService.cancelBuild(filePath);
    }
  }, [filePath, buildStatus, planData, sessionId]);

  // Get todo status icon
  function getTodoIcon(status?: string) {
    switch (status) {
      case 'completed':
        return <Check size={14} className="todo-icon todo-icon--completed" />;
      case 'in_progress':
        return <ArrowRight size={14} className="todo-icon todo-icon--in-progress" />;
      case 'cancelled':
        return <XCircle size={14} className="todo-icon todo-icon--cancelled" />;
      case 'pending':
      default:
        return <Circle size={14} className="todo-icon todo-icon--pending" />;
    }
  }

  // Render loading state
  if (loading) {
    return (
      <div className="ai00-x-plan-viewer ai00-x-plan-viewer--loading">
        <CubeLoading size="medium" text={t('editor.planViewer.loadingPlan')} />
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="ai00-x-plan-viewer ai00-x-plan-viewer--error">
        <div className="error-content">
          <AlertCircle className="error-icon" />
          <p>{error}</p>
          <Button variant="secondary" size="small" onClick={loadFileContent}>
            {t('editor.common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai00-x-plan-viewer">
      <div
        className={`plan-viewer-header ${hasTodos ? 'plan-viewer-header--collapsible' : ''}`}
        onClick={() => {
          if (hasTodos) {
            setIsTodosExpanded(!isTodosExpanded);
          }
        }}
      >
        <div className="header-left">
          {hasTodos && (
            <span
              className={`header-expand-indicator ${isTodosExpanded ? 'header-expand-indicator--expanded' : ''}`}
            >
              <ChevronDown size={14} />
            </span>
          )}
          <FileText size={16} className="file-icon" />
          <span className="file-name">{displayFileName}</span>
          {hasUnsavedChanges && <span className="unsaved-indicator">{t('editor.planViewer.unsaved')}</span>}
        </div>
        <div className="header-right" onClick={(e) => e.stopPropagation()}>
          {hasTodos && (
            <>
              <span className="todos-count">{t('editor.planViewer.remainingTodos', { count: remainingTodos })}</span>

              {workflowPhase === 'executing' || workflowPhase === 'reviewing' ? (
                buildStatus === 'built' ? (
                  <div className="plan-executing-indicator plan-executing-indicator--done">
                    <CheckCircle size={14} />
                    <span>{t('editor.planViewer.built')}</span>
                    {planData?.todos?.length ? (
                      <span className="plan-executing-progress">
                        {planData.todos.filter(t => t.status === 'completed').length}/{planData.todos.length}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="plan-executing-indicator">
                    <Loader2 size={14} className="animate-spin" />
                    <span>{workflowPhase === 'reviewing' ? t('editor.planViewer.reviewing') : t('editor.planViewer.executing')}</span>
                    {planData?.todos?.length ? (
                      <span className="plan-executing-progress">
                        {planData.todos.filter(t => t.status === 'completed').length}/{planData.todos.length}
                      </span>
                    ) : null}
                  </div>
                )
              ) : (
                <button
                  className={`build-btn build-btn--${buildStatus}`}
                  onClick={() => handleBuild()}
                  disabled={buildStatus !== 'build'}
                >
                  {buildStatus === 'building' ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>{t('editor.planViewer.building')}</span>
                    </>
                  ) : buildStatus === 'built' ? (
                    <>
                      <CheckCircle size={14} />
                      <span>{t('editor.planViewer.built')}</span>
                    </>
                  ) : (
                    <span>{t('editor.planViewer.build')}</span>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {hasTodos && isTodosExpanded && renderSharedTodoPanel()}

      <div className="plan-viewer-content">
        <div className="plan-markdown">
          <MEditor
            ref={editorRef}
            value={planContent}
            onChange={handleContentChange}
            onSave={handleSave}
            mode="ir"
            theme={mEditorTheme}
            height="auto"
            width="100%"
            placeholder={t('editor.planViewer.contentPlaceholder')}
            readonly={isPlanLocked}
            toolbar={false}
            filePath={filePath}
            basePath={basePath}
          />
        </div>
      </div>
    </div>
  );
};

export default PlanViewer;

/**
 * AgentComposer — 统一内置 AI 对话输入组件（宿主级）。
 *
 * 红线（决策档案 2026-11-07）：所有需要 AI 对话输入的地方一律用本组件，
 * 禁止再拼第四种实现。形态对齐 DSH/ZCode composer：
 * 一张卡片 = 文本区 + 工具行（左「+」菜单、右模型位 + 思考档位 + 提交键）。
 *
 * 组成 = design-system PromptInput（输入原语）+ @/shared/components/ModelSelector
 * （生产模型选择器：本地 RWKV 槽位 + Ai00-API 套餐/锁/补贴/积分底栏）。
 * 模型接线（与工作台 AI 区同源）：受控值 = 会话当前模型引用
 * （dshSession.models 投影）；切换 = dshSession.selectModel(sessionId,
 * provider, ref, effort)——仅同步会话，不写全局配置/卡片字段。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Folder, GitBranch, Plus } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PromptInput,
  type PromptSubmitIntent,
} from '@/component-library';
import ModelSelector from '@/shared/components/ModelSelector';
import {
  dshPermission,
  dshSession,
  type DshSessionModels,
} from '@/infrastructure/api/service-api/DshAPI';
import { gitAPI } from '@/infrastructure/api/service-api/GitAPI';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import './AgentComposer.scss';

export interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * 提交回调。传了 `running` 时会带提交意图：Enter = 'queue'，
   * Ctrl/Cmd+Enter = 'steer'；未传 running 的旧调用方收到无参数调用。
   */
  onSubmit: (intent?: PromptSubmitIntent) => void;
  onStop?: () => void;
  /** 有提交 RPC 未完成（运行中不再阻止继续排队）。 */
  loading?: boolean;
  /** Agent 当前回合运行中：发送与停止并存、运行中可排队/插话。 */
  running?: boolean;
  /** 运行中是否允许插话；缺省跟随 running（子代理单独运行时传 false）。 */
  steering?: boolean;
  /** 正在停止当前回合（停止按钮防重入）。 */
  stopping?: boolean;
  /** 是否显示 Enter/插话快捷键提示（默认显示）。 */
  showShortcutHint?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** 输入框最大高度 px（透传 PromptInput，默认 200）。 */
  maxHeight?: number;
  /** 视觉变体：hero = 首屏大输入（新任务空态等）。 */
  variant?: 'default' | 'hero';
  /** 绑定会话：模型目录拉取与切换写回的目标（缺省不显示模型选择器）。 */
  sessionId?: string | null;
  /** 是否显示模型选择器（默认 sessionId 存在即显示）。 */
  showModelSelector?: boolean;
  /** 模型切换失败回调（默认 console.error）。 */
  onError?: (message: string) => void;
  /** 追加工具行中部控件（计划/技能等，渲染在「+」右侧）。 */
  controls?: React.ReactNode;
  /** 追加提交键左侧控件（自定义模型位等，渲染在会话模型位/档位位之后）。 */
  trailing?: React.ReactNode;
  /**
   * `@` 文件引用的搜索根目录（项目目录或任务工作目录）。
   * 缺省不启用引用（例如新任务空态还没有目录）。
   */
  mentionRoot?: string;
  /**
   * 尚无会话时的预选模型引用：建会话后由宿主 `ensureTaskSession` 落到该会话。
   */
  pendingModelRef?: string | null;
  /** 无会话时的模型选择回调（宿主暂存，建会话后应用）。 */
  onPendingModelChange?: (ref: string) => void;
  /**
   * 卡片上方的上下文条：工作目录（必填）与显示名。
   * 传了才渲染，并顺带读取该目录的 git 分支。
   */
  workspace?: { dir: string; label?: string };
  /**
   * 卡片顶部的交互档位（提问 / 计划评审 / 交付审核）。
   * 一次只渲染一个；传了就顶掉 `workspace` 那一行——人类介入永远贴着输入框。
   */
  dock?: React.ReactNode;
}

/** 工具行「+」/ `/` 菜单的一行。 */
interface ComposerItem {
  id: string;
  group: 'add' | 'command' | 'file';
  label: string;
  /** 标题右侧的触发写法别名（`@`、`/plan` 等）。 */
  alias?: string;
  hint: string;
  /** 采纳后替换触发词插入的文本。 */
  insert?: string;
  /** 采纳后执行的动作（不插入文本时使用）。 */
  run?: () => void;
}

/** 光标处的触发状态。 */
interface TriggerState {
  kind: 'mention' | 'command';
  query: string;
  /** 触发词在 value 中的起始下标。 */
  start: number;
  /** 触发时的光标下标（采纳时保留其后文本）。 */
  caret: number;
}

interface EffortOption {
  id: string;
  name: string;
}

/** 全局权限档（DSH_PERMISSION_MODE；空串 = 引擎默认 workspace-write）。 */
const PERMISSION_MODES: Array<{
  id: string;
  labelKey: string;
  fallback: string;
  warn?: boolean;
}> = [
  { id: '', labelKey: 'default', fallback: '默认权限' },
  { id: 'read-only', labelKey: 'readOnly', fallback: '只读' },
  { id: 'workspace-write', labelKey: 'workspaceWrite', fallback: '工作区写入' },
  {
    id: 'danger-full-access',
    labelKey: 'fullAccess',
    fallback: '完全访问',
    warn: true,
  },
];

/** 目录里单个模型的可读名与推理档位（切换模型时本地直接套用）。 */
interface ModelMeta {
  name: string;
  efforts: EffortOption[];
  defaultEffort?: string;
  provider: string;
}

/**
 * 计划模板文本：`+` 菜单/`/plan` 采纳后填入输入框，由用户确认后发送。
 * 与任务首轮任务书的 loop 规约保持同一套四段结构。
 */
const PLAN_TEMPLATE = '先写一份计划书（目标 / 步骤 / 验收 / 交付物），确认后再派子代理执行。';

export const AgentComposer: React.FC<AgentComposerProps> = ({
  value,
  onChange,
  onSubmit,
  onStop,
  loading,
  running,
  steering,
  stopping,
  showShortcutHint,
  placeholder,
  disabled,
  maxHeight,
  variant = 'default',
  sessionId,
  showModelSelector = true,
  onError,
  controls,
  trailing,
  mentionRoot,
  pendingModelRef = null,
  onPendingModelChange,
  workspace,
  dock,
}) => {
  const { t } = useI18n('common');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- 全局权限档（重启引擎生效；工具行只做展示与设置入口）----
  const [permMode, setPermMode] = useState<string>('');
  const [permOpen, setPermOpen] = useState(false);
  // ---- 上下文条：当前目录的 git 分支 ----
  const [branch, setBranch] = useState<string | null>(null);

  // ---- 会话模型与思考档位 ----
  /** 当前模型引用（受控值）；切换仅同步会话，不写全局配置。 */
  const [currentRef, setCurrentRef] = useState<string | null>(null);
  /** 引擎目录里的可读名（`ai00-api` → 「AI00-API」等）。 */
  const [currentLabel, setCurrentLabel] = useState<string | null>(null);
  /** 当前模型所属 provider（引擎 selectModel 必填）。 */
  const [currentProvider, setCurrentProvider] = useState<string>('ai00-x');
  /** 引擎目录里可路由的模型引用（选择器的可选范围以此为准）。 */
  const [engineModelRefs, setEngineModelRefs] = useState<string[] | null>(null);
  /** 当前模型声明的推理档位与当前档位（无 efforts 时不渲染档位位）。 */
  const [efforts, setEfforts] = useState<EffortOption[]>([]);
  const [effort, setEffort] = useState<string | null>(null);
  const [effortOpen, setEffortOpen] = useState(false);
  /** 上一次确认的模型/档位：切换失败回滚，避免 UI 与引擎不一致。 */
  const confirmedRef = useRef<{
    ref: string | null;
    label: string | null;
    provider: string;
    effort: string | null;
  }>({ ref: null, label: null, provider: 'ai00-x', effort: null });
  /** 目录投影：模型 id → 可读名/档位/provider。 */
  const modelMetaRef = useRef<Record<string, ModelMeta>>({});
  const aliveRef = useRef(true);

  // ---- 触发菜单（`@` 引用 / `/` 命令 / 「+」launcher）----
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** 被 Esc/Shift+Tab 关掉的 token：同一查询不再自动重开。 */
  const dismissedRef = useRef<string | null>(null);
  /** `@` 候选（相对路径，按需加载一次）。 */
  const [files, setFiles] = useState<string[] | null>(null);
  const filesRootRef = useRef<string | null>(null);

  const notifyError = useCallback(
    (message: string): void => {
      if (onError) onError(message);
      else console.error('[AgentComposer]', message);
    },
    [onError],
  );

  // 权限档只在挂载时读一次（全局设置，改动需重启引擎生效）
  useEffect(() => {
    let alive = true;
    dshPermission.get().then(
      (mode) => {
        if (alive) setPermMode(mode ?? '');
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  // 上下文条的 git 分支（目录不是仓库或读取失败时不显示）
  useEffect(() => {
    if (!workspace?.dir) {
      setBranch(null);
      return undefined;
    }
    let alive = true;
    setBranch(null);
    gitAPI
      .getStatus(workspace.dir)
      .then((status) => {
        if (alive) setBranch(status.current_branch ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspace?.dir]);

  /** 加载引用根目录的文件清单（浅层，最大 3 层）。 */
  const ensureFiles = useCallback((): void => {
    if (!mentionRoot || filesRootRef.current === mentionRoot) return;
    filesRootRef.current = mentionRoot;
    setFiles(null);
    void import('@/infrastructure/api/service-api/WorkspaceAPI')
      .then(({ workspaceAPI }) => workspaceAPI.getFileTree(mentionRoot, 3))
      .then((nodes) => {
        const out: string[] = [];
        const walk = (list: typeof nodes, prefix: string): void => {
          for (const node of list) {
            const rel = prefix ? `${prefix}/${node.name}` : node.name;
            if (node.isDirectory) {
              if (out.length < 3000) walk(node.children ?? [], rel);
            } else if (out.length < 3000) {
              out.push(rel);
            }
          }
        };
        walk(nodes, '');
        setFiles(out);
      })
      .catch(() => setFiles([]));
  }, [mentionRoot]);

  /** 打开菜单（同一 token 已被 Esc 关掉时不再重开）。 */
  const openMenu = useCallback((next: TriggerState): void => {
    const key = `${next.kind}:${next.start}:${next.query}`;
    if (dismissedRef.current === key) {
      setTrigger(null);
      return;
    }
    dismissedRef.current = null;
    setTrigger(next);
    setHighlight(0);
  }, []);

  const closeMenu = useCallback((): void => {
    setTrigger(null);
    setHighlight(0);
  }, []);

  const handleCaretContext = useCallback(
    (context: { before: string; value: string }): void => {
      const { before, value: whole } = context;
      if (mentionRoot) {
        const mention = /(^|\s)@([^\s@]*)$/.exec(before);
        if (mention) {
          ensureFiles();
          const query = mention[2] ?? '';
          openMenu({
            kind: 'mention',
            query,
            start: before.length - query.length - 1,
            caret: before.length,
          });
          return;
        }
      }
      if (whole.startsWith('/') && !whole.includes('\n')) {
        openMenu({ kind: 'command', query: whole.slice(1), start: 0, caret: whole.length });
        return;
      }
      closeMenu();
    },
    [closeMenu, ensureFiles, mentionRoot, openMenu],
  );

  const commandItems = useMemo<ComposerItem[]>(() => {
    return [
      {
        id: 'reference',
        group: 'add',
        label: t('nav.workbenchWindow.composer.referenceFile'),
        alias: '@',
        hint: t('nav.workbenchWindow.composer.referenceFileHint'),
        insert: mentionRoot ? '@' : '',
      },
      {
        id: 'plan',
        group: 'command',
        label: '/plan',
        hint: t('nav.workbenchWindow.composer.planHint'),
        insert: PLAN_TEMPLATE,
      },
      {
        id: 'stop',
        group: 'command',
        label: '/stop',
        hint: t('nav.workbenchWindow.composer.stopHint'),
        run: () => onStop?.(),
      },
      {
        id: 'clear',
        group: 'command',
        label: '/clear',
        hint: t('nav.workbenchWindow.composer.clearHint'),
        run: () => onChange(''),
      },
    ].filter((item) => item.insert !== '' || item.run) as ComposerItem[];
  }, [mentionRoot, onChange, onStop, t]);

  const items = useMemo<ComposerItem[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    if (trigger.kind === 'mention') {
      if (!files) return [];
      return files
        .filter((path) => path.toLowerCase().includes(query))
        .slice(0, 8)
        .map((path) => ({
          id: path,
          group: 'file' as const,
          label: path,
          hint: '',
          insert: path,
        }));
    }
    if (!query) return commandItems;
    return commandItems.filter(
      (item) =>
        item.id.includes(query) ||
        item.label.toLowerCase().includes(query) ||
        (item.alias ?? '').toLowerCase().includes(query),
    );
  }, [commandItems, files, trigger]);

  /** 采纳当前高亮项（或指定项）：替换触发词，保留光标后的文本。 */
  const applyItem = useCallback(
    (item: ComposerItem): void => {
      if (!trigger) return;
      const head = value.slice(0, trigger.start);
      const tail = value.slice(trigger.caret);
      if (item.run) {
        item.run();
      } else if (item.insert !== undefined) {
        const insert = item.group === 'file' ? `@${item.insert} ` : item.insert;
        onChange(`${head}${insert}${tail}`);
        if (item.id === 'reference') {
          // 「引用文件」采纳后直接接上 `@` 候选，不让用户再手敲一次
          ensureFiles();
          openMenu({ kind: 'mention', query: '', start: head.length, caret: head.length + 1 });
        }
      }
      if (item.id !== 'reference') closeMenu();
      // 采纳不发送：焦点还给编辑器
      textareaRef.current?.focus();
    },
    [closeMenu, ensureFiles, onChange, openMenu, trigger, value],
  );

  /** 菜单键盘：↑↓ 移动高亮、Enter/Tab 采纳、Esc/Shift+Tab 关闭。 */
  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!trigger || items.length === 0) return false;
      if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
        dismissedRef.current = `${trigger.kind}:${trigger.start}:${trigger.query}`;
        closeMenu();
        return true;
      }
      if (event.key === 'ArrowDown') {
        setHighlight((index) => (index + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setHighlight((index) => (index - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.shiftKey || event.nativeEvent.isComposing) return false;
        applyItem(items[Math.min(highlight, items.length - 1)]);
        return true;
      }
      return false;
    },
    [applyItem, closeMenu, highlight, items, trigger],
  );

  /** 「+」：与 `/` 打开同一个菜单，插入点取当前光标处。 */
  const openLauncher = useCallback((): void => {
    if (trigger) {
      closeMenu();
      return;
    }
    openMenu({ kind: 'command', query: '', start: value.length, caret: value.length });
    textareaRef.current?.focus();
  }, [closeMenu, openMenu, trigger, value.length]);

  // ---- 会话模型目录 ----
  const applyModels = useCallback((models: DshSessionModels): void => {
    const selection = models.current;
    const info = models.groups
      .flatMap((group) => group.models)
      .find((model) => model.id === selection?.model);
    const provider =
      models.groups.find((group) => group.models.some((m) => m.id === selection?.model))?.id ??
      selection?.provider ??
      'ai00-x';
    const ref = selection?.model ?? null;
    const label = info?.name ?? null;
    const nextEffort = selection?.reasoningEffort ?? null;
    // 目录里每个模型的可读名与推理档位（切换模型后不用再拉一次目录）
    const meta: Record<string, ModelMeta> = {};
    for (const group of models.groups) {
      for (const model of group.models) {
        meta[model.id] = {
          name: model.name,
          efforts: model.reasoning?.efforts ?? [],
          defaultEffort: model.reasoning?.defaultEffort,
          provider: group.id,
        };
      }
    }
    modelMetaRef.current = meta;
    setCurrentRef(ref);
    setCurrentLabel(label);
    setCurrentProvider(provider);
    setEffort(nextEffort);
    setEfforts(info?.reasoning?.efforts ?? []);
    setEngineModelRefs(models.groups.flatMap((group) => group.models).map((m) => m.id));
    confirmedRef.current = { ref, label, provider, effort: nextEffort };
  }, []);

  const reloadModels = useCallback((): void => {
    if (!sessionId) return;
    void dshSession
      .models(sessionId)
      .then((models) => {
        if (aliveRef.current) applyModels(models);
      })
      .catch(() => undefined); // 目录拉取失败不阻塞输入
  }, [applyModels, sessionId]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setCurrentRef(null);
    setCurrentLabel(null);
    setCurrentProvider('ai00-x');
    setEffort(null);
    setEfforts([]);
    setEngineModelRefs(null);
    confirmedRef.current = { ref: null, label: null, provider: 'ai00-x', effort: null };
    if (!sessionId) {
      // 新建任务空态：沿用宿主暂存的预选模型（建会话后再落到该会话）
      setCurrentRef(pendingModelRef);
      return;
    }
    reloadModels();
  }, [pendingModelRef, reloadModels, sessionId]);

  // 存量会话可能钉着已下架的模型（上游换模型后如 `ai00s:GLM-4.7-Flash`）：
  // 引擎目录里已经没有它，继续发请求必得 404 model_not_found。这里自动切到
  // 目录里可用的模型（优先具体 Ai00-API 子模型），避免用户手动逐个会话修。
  useEffect(() => {
    if (!sessionId || !currentRef || !engineModelRefs || engineModelRefs.length === 0) return;
    if (engineModelRefs.includes(currentRef)) return;
    const fallback = engineModelRefs.find(ref => ref.startsWith('ai00s:')) ?? engineModelRefs[0];
    if (!fallback || fallback === currentRef) return;
    const meta = modelMetaRef.current[fallback];
    const provider = meta?.provider ?? 'ai00-x';
    dshSession
      .selectModel(sessionId, provider, fallback)
      .then(() => {
        setCurrentRef(fallback);
        setCurrentLabel(null);
        setCurrentProvider(provider);
        setEfforts(meta?.efforts ?? []);
        setEffort(meta?.defaultEffort ?? null);
        confirmedRef.current = {
          ref: fallback,
          label: meta?.name ?? null,
          provider,
          effort: meta?.defaultEffort ?? null,
        };
      })
      .catch(() => undefined);
  }, [sessionId, currentRef, engineModelRefs]);

  const handleSelectModel = (ref: string): void => {
    // 无会话（新建任务空态）：先暂存，建会话后由宿主落到该会话
    if (!sessionId) {
      setCurrentRef(ref);
      setCurrentLabel(null);
      onPendingModelChange?.(ref);
      return;
    }
    if (running || stopping) return;
    const previous = confirmedRef.current;
    const meta = modelMetaRef.current[ref];
    // 手工切换后由 ModelSelector 自己解析展示名（应用模型域/ai00s 子模型都能解析）
    setCurrentRef(ref);
    setCurrentLabel(null);
    dshSession
      .selectModel(sessionId, meta?.provider ?? currentProvider, ref)
      .then(() => {
        // 引擎按新模型的默认档位生效：本地同步，避免再拉一次目录拿到旧投影
        setCurrentProvider(meta?.provider ?? currentProvider);
        setEfforts(meta?.efforts ?? []);
        setEffort(meta?.defaultEffort ?? null);
        confirmedRef.current = {
          ref,
          label: meta?.name ?? null,
          provider: meta?.provider ?? currentProvider,
          effort: meta?.defaultEffort ?? null,
        };
      })
      .catch((err) => {
        // 失败回滚：保持 UI 与实际会话模型一致
        setCurrentRef(previous.ref);
        setCurrentLabel(previous.label);
        setCurrentProvider(previous.provider);
        setEffort(previous.effort);
        const message = err instanceof Error ? err.message : String(err);
        notifyError(message);
      });
  };

  const handleSelectEffort = (nextEffort: string): void => {
    setEffortOpen(false);
    if (!sessionId || !currentRef || running || stopping) return;
    if (nextEffort === effort) return;
    const previous = confirmedRef.current;
    setEffort(nextEffort);
    dshSession
      .selectModel(sessionId, currentProvider, currentRef, nextEffort)
      .then(() => {
        confirmedRef.current = { ...previous, effort: nextEffort };
      })
      .catch((err) => {
        setEffort(previous.effort);
        const message = err instanceof Error ? err.message : String(err);
        notifyError(message);
      });
  };

  const effortLabel = useMemo(
    () => efforts.find((option) => option.id === effort)?.name ?? effort,
    [effort, efforts],
  );

  // ---- 工具行：权限档（全局，重启引擎生效）----
  const handlePermMode = (mode: string): void => {
    setPermOpen(false);
    if (mode === permMode) return;
    const previous = permMode;
    setPermMode(mode);
    dshPermission.set(mode || null).catch((err) => {
      setPermMode(previous);
      notifyError(err instanceof Error ? err.message : String(err));
    });
  };

  const permEntry = PERMISSION_MODES.find((mode) => mode.id === permMode) ?? PERMISSION_MODES[0];
  const permissionSeat = (
    <Popover open={permOpen} onOpenChange={setPermOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`ai00-x-composer-perm${permEntry.warn ? ' is-warn' : ''}`}
          title={t('nav.workbenchWindow.composer.permission.hint')}
        >
          {permEntry.warn && <AlertTriangle size={12} />}
          <span>
            {t(`nav.workbenchWindow.composer.permission.${permEntry.labelKey}`, {
              defaultValue: permEntry.fallback,
            })}
          </span>
          <ChevronDown size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="ai00-x-composer-perm-menu"
      >
        {PERMISSION_MODES.map((mode) => (
          <button
            key={mode.id || 'default'}
            type="button"
            role="menuitemradio"
            aria-checked={mode.id === permMode}
            className={`ai00-x-composer-perm-menu__item${
              mode.id === permMode ? ' is-active' : ''
            }${mode.warn ? ' is-warn' : ''}`}
            onClick={() => handlePermMode(mode.id)}
          >
            <span>{t(`nav.workbenchWindow.composer.permission.${mode.labelKey}`, {
              defaultValue: mode.fallback,
            })}</span>
            {mode.id === permMode && <Check size={12} />}
          </button>
        ))}
        <p className="ai00-x-composer-perm-menu__note">
          {t('nav.workbenchWindow.composer.permission.restartHint')}
        </p>
      </PopoverContent>
    </Popover>
  );

  // ---- 卡片上方上下文条：工作目录 + git 分支 ----
  const workspaceRow = workspace ? (
    <div className="ai00-x-composer-workspace" title={workspace.dir}>
      <Folder size={14} className="ai00-x-composer-workspace__icon" />
      <span className="ai00-x-composer-workspace__name">
        {workspace.label ??
          workspace.dir.split(/[\\/]/).filter(Boolean).pop() ??
          workspace.dir}
      </span>
      {branch && (
        <>
          <span className="ai00-x-composer-workspace__divider" />
          <GitBranch size={13} className="ai00-x-composer-workspace__icon" />
          <span className="ai00-x-composer-workspace__branch">{branch}</span>
        </>
      )}
    </div>
  ) : null;

  // ---- 候选菜单 ----
  const overlay = useMemo(() => {
    if (!trigger || items.length === 0) return null;
    const rows: React.ReactNode[] = [];
    let currentGroup: string | null = null;
    items.forEach((item, index) => {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        rows.push(
          <div key={`group-${item.group}`} className="ai00-x-composer-pop__group">
            {t(`nav.workbenchWindow.composer.group.${item.group}`)}
          </div>,
        );
      }
      rows.push(
        <button
          key={item.id}
          id={`ai00-x-composer-item-${item.id}`}
          type="button"
          role="option"
          aria-selected={index === highlight}
          className={`ai00-x-composer-pop__item${index === highlight ? ' is-active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyItem(item)}
          title={item.label}
        >
          <span className="ai00-x-composer-pop__label">{item.label}</span>
          {item.alias && <span className="ai00-x-composer-pop__alias">{item.alias}</span>}
          <span className="ai00-x-composer-pop__hint">{item.hint}</span>
        </button>,
      );
    });
    return (
      <div
        className="ai00-x-composer-pop"
        role="listbox"
        aria-label={t('nav.workbenchWindow.composer.menuLabel')}
      >
        {rows}
      </div>
    );
  }, [applyItem, highlight, items, t, trigger]);

  const activeDescendantId =
    trigger && items.length > 0
      ? `ai00-x-composer-item-${items[Math.min(highlight, items.length - 1)]?.id}`
      : undefined;

  // ---- 工具行槽位 ----
  const addButton = (
    <button
      type="button"
      className={`ai00-x-composer-add${trigger ? ' is-open' : ''}`}
      onClick={openLauncher}
      disabled={disabled}
      aria-label={t('nav.workbenchWindow.composer.add')}
      aria-expanded={Boolean(trigger)}
      title={t('nav.workbenchWindow.composer.add')}
    >
      <Plus size={16} />
    </button>
  );

  const modelSeat = showModelSelector ? (
    <ModelSelector
      currentMode="agent-composer"
      controlledValue={currentRef}
      onControlledSelect={handleSelectModel}
      disabled={Boolean(running || stopping)}
      displayLabel={currentLabel}
      allowedModelRefs={engineModelRefs}
      showEffortBadge={false}
    />
  ) : null;

  const effortSeat =
    sessionId && efforts.length > 0 ? (
      <Popover open={effortOpen} onOpenChange={setEffortOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="ai00-x-composer-effort"
            disabled={Boolean(running || stopping)}
            aria-label={t('nav.workbenchWindow.composer.effortHint')}
            title={t('nav.workbenchWindow.composer.effortHint')}
          >
            <span>{effortLabel ?? t('nav.workbenchWindow.composer.effort')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={6} className="ai00-x-composer-effort-menu">
          {efforts.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === effort}
              className={`ai00-x-composer-effort-menu__item${
                option.id === effort ? ' is-active' : ''
              }`}
              onClick={() => handleSelectEffort(option.id)}
            >
              <span>{option.name}</span>
              {option.id === effort && <Check size={12} />}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    ) : null;

  return (
    <PromptInput
      ref={textareaRef}
      className="ai00-x-composer-root"
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      onStop={onStop}
      loading={loading}
      running={running}
      steering={steering}
      stopping={stopping}
      showShortcutHint={showShortcutHint}
      placeholder={placeholder}
      disabled={disabled}
      maxHeight={maxHeight}
      variant={variant}
      onCaretContext={handleCaretContext}
      menuOpen={Boolean(trigger && items.length > 0)}
      onMenuKeyDown={handleMenuKeyDown}
      activeDescendantId={activeDescendantId}
      overlay={overlay}
      leading={addButton}
      above={dock ?? workspaceRow}
      controls={
        <>
          {permissionSeat}
          {controls}
        </>
      }
      trailing={
        <>
          {modelSeat}
          {effortSeat}
          {trailing}
        </>
      }
    />
  );
};

export default AgentComposer;

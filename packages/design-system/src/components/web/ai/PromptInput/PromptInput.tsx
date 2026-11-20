/**
 * PromptInput —— AI 对话输入框（v0.17 对齐 DSH/ZCode composer 形态）
 *
 * 形态 = 一张卡片 + 卡下 dock：
 *   card: [ 候选菜单锚点 ] [ textarea ] [ 工具行 = leading / controls / trailing + 提交键 ]
 *   dock: 快捷键提示等辅助读数（窄容器隐藏）
 *
 * 与 v0.16 的差异：删除 footer 分隔线（footer/footerLeft/footerRight → 工具行槽位），
 * 发送键从文本行移入工具行右端，候选浮层改为卡片上方绝对定位（不撑高输入框），
 * 并给业务方提供菜单键盘拦截点（menuOpen + onMenuKeyDown）。
 */
import React, { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { label } from '../../../../lib/labels';
import './PromptInput.scss';

export interface PromptInputProps {
  value: string;
  onChange(v: string): void;
  /**
   * Enter 触发（非 IME 合成中）。
   *
   * 传了 `running` 时回调会带上提交意图：常规 Enter 为 `'queue'`，
   * Ctrl/Cmd+Enter 为 `'steer'`；旧调用方不传 running，回调无参数。
   */
  onSubmit?(intent?: PromptSubmitIntent): void;
  /** 停止当前回合（与发送并存：不替换发送按钮）。 */
  onStop?(): void;
  /**
   * 有提交 RPC 未完成。
   *
   * 旧契约（未传 running）：loading 同时禁用发送并把发送按钮换成停止。
   * 新契约（传了 running）：loading 只表达提交中，不阻止继续排队。
   */
  loading?: boolean;
  /**
   * Agent 当前回合仍在运行（启用「发送 + 停止并存、运行中可排队/插话」契约）。
   */
  running?: boolean;
  /**
   * 运行中是否允许插话（Ctrl/Cmd+Enter → 'steer'）。
   * 缺省跟随 `running`（旧调用方零改动）；传 false 时一律按排队处理。
   */
  steering?: boolean;
  /** 正在停止当前回合（停止按钮防重入，发送仍可用）。 */
  stopping?: boolean;
  /** 快捷键提示是否显示（默认 true；窄容器自动隐藏）。 */
  showShortcutHint?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** px，默认 200；超出内滚 */
  maxHeight?: number;
  /** 工具行最左槽位（「+」菜单入口等）。 */
  leading?: React.ReactNode;
  /** 卡片上方的上下文条（工作目录 / 分支等；不参与卡片边框）。 */
  above?: React.ReactNode;
  /** 工具行中左槽位（计划/技能等常驻控件）。 */
  controls?: React.ReactNode;
  /** 提交键左侧槽位（模型位、思考档位）。 */
  trailing?: React.ReactNode;
  /** 卡片上方的候选浮层（`@` 引用、`/` 命令面板；由业务侧渲染内容）。 */
  overlay?: React.ReactNode;
  /** 候选浮层是否打开：打开时 Enter 交给 onMenuKeyDown，不直接发送。 */
  menuOpen?: boolean;
  /** 候选浮层键盘裁决（↑↓ / Enter / Tab / Esc）；返回 true 表示已消费。 */
  onMenuKeyDown?(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** 浮层高亮项 id（透传 textarea 的 aria-activedescendant）。 */
  activeDescendantId?: string;
  /** 光标附近的文本变化回调（用于 @ / 触发词检测；不改变输入值语义）。 */
  onCaretContext?(context: { before: string; value: string }): void;
  /** 视觉变体：hero = 首屏大输入（更矮的起始高度、两行占位）。 */
  variant?: 'default' | 'hero';
  className?: string;
}

/** 提交意图：排队（默认）或在安全边界插话。 */
export type PromptSubmitIntent = 'queue' | 'steer';

/** 圆形发送按钮（ArrowUp）。 */
const SendIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M8 13V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 停止图标（方点）。 */
const StopIcon = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" fill="currentColor" />
  </svg>
);

/** 排队图标（列表 + 加号，示意「加入队列」）。 */
const QueueIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2.5 4.5h7M2.5 8h7M2.5 11.5h4.5M12 9.5v4M10 11.5h4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

export const PromptInput = forwardRef<HTMLTextAreaElement, PromptInputProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      onStop,
      loading = false,
      running,
      steering,
      stopping = false,
      showShortcutHint = true,
      placeholder,
      disabled = false,
      maxHeight = 200,
      leading,
      above,
      controls,
      trailing,
      overlay,
      menuOpen = false,
      onMenuKeyDown,
      activeDescendantId,
      onCaretContext,
      variant = 'default',
      className = '',
    },
    ref,
  ) => {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const composingRef = useRef(false);
    const [composing, setComposing] = useState(false);

    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      },
      [ref],
    );

    // 自增高（maxHeight 内）
    useLayoutEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }, [value, maxHeight]);

    /** 新契约（显式传 running）：运行中仍可提交。旧契约保持 loading 禁发。 */
    const isRunningContract = running !== undefined;
    /** 插话资格由主回合决定；子代理单独在跑时只排队，不宣称可插话。 */
    const canSteer = (steering ?? Boolean(running)) === true;
    const hasText = value.trim().length > 0;
    const canSend = isRunningContract
      ? !disabled && hasText
      : !disabled && !loading && hasText;
    /** 旧契约里「停止替换发送」只在运行态成立。 */
    const showStopInsteadOfSend = !isRunningContract && loading && Boolean(onStop);

    const submit = useCallback(
      (intent: PromptSubmitIntent) => {
        if (!canSend || !onSubmit) return;
        if (isRunningContract) onSubmit(intent);
        else onSubmit();
      },
      [canSend, isRunningContract, onSubmit],
    );

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 候选浮层优先：Enter/Tab/↑↓/Esc 由业务方裁决，采纳不触发发送
      if (menuOpen && onMenuKeyDown && onMenuKeyDown(e)) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Enter') return;
      // IME 合成中（含 keyCode 229 遗留行为）不拦截
      if (composingRef.current || composing || e.nativeEvent.isComposing) return;
      if (e.shiftKey) return; // Shift+Enter 换行
      e.preventDefault();
      // Ctrl/Cmd+Enter = 在安全边界插话；空闲或不可插话时按普通排队处理
      const accelerated = (e.ctrlKey || e.metaKey) && isRunningContract && canSteer;
      submit(accelerated ? 'steer' : 'queue');
    };

    const defaultHint = isRunningContract && running
      ? canSteer
        ? label('components.ai.runningHint', 'Enter 排队 · Ctrl/Cmd+Enter 插话')
        : label('components.ai.queueOnlyHint', 'Enter 排队等待当前任务')
      : label('components.ai.idleHint', 'Enter 发送 · Shift+Enter 换行');
    const hasDock = showShortcutHint;

    return (
      <div
        className={[
          'ai-prompt-input',
          `ai-prompt-input--${variant}`,
          disabled && 'is-disabled',
          isRunningContract && running && 'is-running',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {above && <div className="ai-prompt-input__above">{above}</div>}
        <div className="ai-prompt-input__card">
          {overlay}
          <textarea
            ref={setRefs}
            className="ai-prompt-input__textarea"
            value={value}
            placeholder={placeholder ?? label('components.ai.placeholder', '给 AI 发送消息…')}
            disabled={disabled}
            rows={1}
            aria-activedescendant={menuOpen ? activeDescendantId : undefined}
            aria-expanded={menuOpen || undefined}
            aria-autocomplete={menuOpen ? 'list' : undefined}
            onChange={(e) => {
              onChange(e.target.value);
              if (onCaretContext) {
                const el = e.currentTarget;
                onCaretContext({
                  before: e.target.value.slice(0, el.selectionStart ?? e.target.value.length),
                  value: e.target.value,
                });
              }
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
              setComposing(true);
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              setComposing(false);
            }}
          />
          <div className="ai-prompt-input__tools">
            {leading && <div className="ai-prompt-input__leading">{leading}</div>}
            {controls && <div className="ai-prompt-input__controls">{controls}</div>}
            <div className="ai-prompt-input__trailing">
              {trailing}
              {isRunningContract && onStop && running && (
                <button
                  type="button"
                  className="ai-prompt-input__stop"
                  onClick={onStop}
                  disabled={stopping}
                  aria-label={
                    stopping
                      ? label('components.ai.stopping', '正在停止…')
                      : label('components.ai.stopTurn', '停止当前回合')
                  }
                  title={
                    stopping
                      ? label('components.ai.stopping', '正在停止…')
                      : label('components.ai.stopTurn', '停止当前回合')
                  }
                >
                  <StopIcon />
                </button>
              )}
              {showStopInsteadOfSend ? (
                <button
                  type="button"
                  className="ai-prompt-input__stop"
                  onClick={onStop}
                  aria-label={label('components.ai.stop', '停止')}
                  title={label('components.ai.stop', '停止')}
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  type="button"
                  className={`ai-prompt-input__send${isRunningContract && running ? ' is-queue' : ''}`}
                  disabled={!canSend}
                  onClick={() => submit('queue')}
                  aria-label={
                    isRunningContract && running
                      ? label('components.ai.queue', '加入排队')
                      : label('components.ai.send', '发送')
                  }
                  title={
                    isRunningContract && running
                      ? label('components.ai.queueHint', '加入排队（Enter），Ctrl/Cmd+Enter 在安全边界插话')
                      : label('components.ai.send', '发送')
                  }
                >
                  {isRunningContract && running ? <QueueIcon /> : <SendIcon />}
                </button>
              )}
            </div>
          </div>
        </div>
        {hasDock && (
          <div className="ai-prompt-input__dock">
            <span className="ai-prompt-input__hint">{defaultHint}</span>
          </div>
        )}
      </div>
    );
  },
);
PromptInput.displayName = 'PromptInput';

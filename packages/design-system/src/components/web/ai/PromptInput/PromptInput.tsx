/**
 * PromptInput —— AI 聊天输入框（v0.16 AI 系，antd X Sender 对位）
 * ChatInput 降耦重制：自增高 + Enter 发送（IME 合成中不触发）+
 * loading→停止按钮；footer slot 供业务扩展（模型选择走配套 ModelSelector）。
 * v0.16：发送/停止改圆形图标按钮（ArrowUp / 方点呼吸）；footer 左右分区
 * （footerLeft=模型选择等 / footerRight=辅助信息），footer 兜底整行。
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
   * 不传则保持旧行为，避免其他场景被静默改变。
   */
  running?: boolean;
  /** 正在停止当前回合（停止按钮防重入，发送仍可用）。 */
  stopping?: boolean;
  /** 排队与插话的提示文案是否显示（默认 true；窄栏可关闭）。 */
  showShortcutHint?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** px，默认 200；超出内滚 */
  maxHeight?: number;
  /** 底部扩展条（旧整行 slot；与 footerLeft/footerRight 互斥优先） */
  footer?: React.ReactNode;
  /** 底部左侧（模型选择/工具入口等） */
  footerLeft?: React.ReactNode;
  /** 底部右侧（辅助信息：字数/快捷键提示等） */
  footerRight?: React.ReactNode;
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
      stopping = false,
      showShortcutHint = true,
      placeholder,
      disabled = false,
      maxHeight = 200,
      footer,
      footerLeft,
      footerRight,
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
      if (e.key !== 'Enter') return;
      // IME 合成中（含 keyCode 229 遗留行为）不拦截
      if (composingRef.current || composing || e.nativeEvent.isComposing) return;
      if (e.shiftKey) return; // Shift+Enter 换行
      e.preventDefault();
      // Ctrl/Cmd+Enter = 在安全边界插话；空闲时由调用方按普通发送处理
      const accelerated = (e.ctrlKey || e.metaKey) && isRunningContract;
      submit(accelerated ? 'steer' : 'queue');
    };

    // 旧调用方没有任何 footer 槽时不新增 footer（避免悄悄改变既有场景布局）
    const hasContainers = footer != null || footerLeft != null || footerRight != null;
    const hasFooter = hasContainers || (showShortcutHint && isRunningContract);
    const defaultHint = isRunningContract && running
      ? label(
          'components.ai.runningHint',
          'Enter 排队 · Ctrl/Cmd+Enter 插话',
        )
      : label('components.ai.idleHint', 'Enter 发送 · Shift+Enter 换行');

    return (
      <div className={['ai-prompt-input', disabled && 'is-disabled', className].filter(Boolean).join(' ')}>
        <div className="ai-prompt-input__row">
          <textarea
            ref={setRefs}
            className="ai-prompt-input__textarea"
            value={value}
            placeholder={placeholder ?? label('components.ai.placeholder', '给 AI 发送消息…')}
            disabled={disabled}
            rows={1}
            onChange={(e) => onChange(e.target.value)}
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
        {hasFooter && (
          <div className="ai-prompt-input__footer">
            {footer ?? (
              <>
                <div className="ai-prompt-input__footer-left">{footerLeft}</div>
                <div className="ai-prompt-input__footer-right">
                  {footerRight ??
                    (showShortcutHint && isRunningContract ? <span>{defaultHint}</span> : null)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);
PromptInput.displayName = 'PromptInput';

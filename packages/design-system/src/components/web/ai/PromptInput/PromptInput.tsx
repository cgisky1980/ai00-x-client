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
  /** Enter 触发（非 IME 合成中）；提供 onStop 时 Enter 常规发送 */
  onSubmit?(): void;
  /** 提供后 loading 态按钮变「停止」 */
  onStop?(): void;
  loading?: boolean;
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

export const PromptInput = forwardRef<HTMLTextAreaElement, PromptInputProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      onStop,
      loading = false,
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

    const canSend = !disabled && !loading && value.trim().length > 0;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter') return;
      // IME 合成中（含 keyCode 229 遗留行为）不拦截
      if (composingRef.current || composing || e.nativeEvent.isComposing) return;
      if (e.shiftKey) return; // Shift+Enter 换行
      e.preventDefault();
      if (canSend && onSubmit) onSubmit();
    };

    const hasFooter = footer != null || footerLeft != null || footerRight != null;

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
          {loading && onStop ? (
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
              className="ai-prompt-input__send"
              disabled={!canSend}
              onClick={() => onSubmit?.()}
              aria-label={label('components.ai.send', '发送')}
              title={label('components.ai.send', '发送')}
            >
              <SendIcon />
            </button>
          )}
        </div>
        {hasFooter && (
          <div className="ai-prompt-input__footer">
            {footer ?? (
              <>
                <div className="ai-prompt-input__footer-left">{footerLeft}</div>
                <div className="ai-prompt-input__footer-right">{footerRight}</div>
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);
PromptInput.displayName = 'PromptInput';

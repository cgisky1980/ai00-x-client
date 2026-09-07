/**
 * MentionInput — 带 @提及补全的单行输入框
 *
 * 输入 `@` 触发补全面板（chatApi.searchMembers 防抖查询）：
 * ↑↓ 选择、Enter 确认（选中候选时不触发发送）、Esc 关闭、点击候选插入。
 * 选中后把光标前 `@query` 替换为 `@username `。
 * Enter 行为通过 onEnter 上抛（无补全面板时才触发）。
 */
import React from 'react';
import { createLogger } from '@/shared/utils/logger';
import { applyMention, extractMentionQuery, searchMentionMembers } from './mention';
import type { MemberHit } from '../chatApi';

const log = createLogger('MentionInput');

export const MentionInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  ariaLabel?: string;
  disabled?: boolean;
}> = ({ value, onChange, onEnter, className, placeholder, maxLength, ariaLabel, disabled }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState<string | null>(null);
  const [hits, setHits] = React.useState<MemberHit[]>([]);
  const [active, setActive] = React.useState(0);
  const reqIdRef = React.useRef(0);

  // 补全查询（300ms 防抖 + 请求序号竞态守卫）
  React.useEffect(() => {
    if (query == null) {
      setHits([]);
      return;
    }
    const reqId = ++reqIdRef.current;
    const timer = window.setTimeout(() => {
      void searchMentionMembers(query)
        .then((result) => {
          if (reqIdRef.current === reqId) {
            setHits(result);
            setActive(0);
          }
        })
        .catch((e) => log.warn('mention search failed', e));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const open = query != null && hits.length > 0;
  const close = () => setQuery(null);

  const refreshQuery = (el: HTMLInputElement) => {
    setQuery(extractMentionQuery(el.value.slice(0, el.selectionStart ?? el.value.length)));
  };

  const pick = (hit: MemberHit) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const applied = applyMention(el.value, caret, hit.username);
    onChange(applied.value);
    close();
    // 等受控 value 渲染后落光标
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(applied.caret, applied.caret);
    });
  };

  return (
    <span className="community-mention-input">
      <input
        ref={inputRef}
        className={className}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          refreshQuery(e.target);
        }}
        onKeyUp={(e) => refreshQuery(e.currentTarget)}
        onClick={(e) => refreshQuery(e.currentTarget)}
        onBlur={() => {
          // 点击候选先于 blur 生效；延时关闭避免吃掉点击
          window.setTimeout(() => setQuery(null), 120);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => (i + 1) % hits.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => (i - 1 + hits.length) % hits.length);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
              return;
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pick(hits[active]);
              return;
            }
          }
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label={ariaLabel}
      />
      {open && (
        <div className="community-mention-pop" role="listbox" aria-label="提及成员">
          {hits.map((h, i) => (
            <button
              key={h.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`community-mention-pop__item ${i === active ? 'is-active' : ''}`}
              // onMouseDown 先于 input blur，保证点击选择生效
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
            >
              <span className="community-mention-pop__name">{h.nickname || h.username}</span>
              <span className="community-mention-pop__username ds-data">@{h.username}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
};

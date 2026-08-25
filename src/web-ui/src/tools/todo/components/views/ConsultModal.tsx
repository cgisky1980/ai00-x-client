/**
 * ConsultModal — 细谈式创建模态（面板内，非新窗口）。
 * 对话流（问/答气泡）→ 草稿确认页（字段可编辑）→ 入库。
 */
import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { ConsultDraft } from '../../ai/consult';
import type { ConsultState } from '../../hooks/useConsult';
import { REPEAT_LABELS } from '../../api/labels';

export const ConsultModal: React.FC<{
  state: ConsultState;
  answer: (text: string) => void;
  skip: () => void;
  close: () => void;
  adopt: (d: ConsultDraft) => void;
}> = ({ state, answer, skip, close, adopt }) => {
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<ConsultDraft | null>(state.draft);

  // 草稿页：同步外部草稿（生成完成时）
  if (state.phase === 'draft' && state.draft && draft?.title !== state.draft.title) {
    setDraft(state.draft);
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && input.trim()) {
      answer(input.trim());
      setInput('');
    } else if (e.key === 'Escape') {
      close();
    }
  };

  return (
    <div className="td-consult" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="td-consult-card">
        <div className="td-consult-head">
          细谈创建
          <span style={{ flex: 1 }} />
          <button
            className="todo-panel__close"
            style={{ width: 24, height: 24 }}
            onClick={close}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="td-consult-body">
          {/* 主诉（用户想做啥） */}
          <div className="td-consult-q">我想做：{state.main || '（待输入）'}</div>

          {/* 已完成的问答 */}
          {state.qa.map((item, i) => (
            <React.Fragment key={i}>
              <div className="td-consult-q">{item.q}</div>
              <div className="td-consult-a">{item.a}</div>
            </React.Fragment>
          ))}

          {/* 当前问题 */}
          {state.phase === 'asking' && state.pendingQuestion && (
            <div className="td-consult-q">{state.pendingQuestion}</div>
          )}
          {state.phase === 'asking' && !state.pendingQuestion && (
            <div className="td-consult-status">思考中…</div>
          )}
          {state.phase === 'drafting' && <div className="td-consult-status">生成任务草稿…</div>}
          {state.phase === 'error' && <div className="td-consult-status">{state.error}</div>}

          {/* 草稿确认页 */}
          {state.phase === 'draft' && draft && (
            <DraftEditor draft={draft} onChange={setDraft} />
          )}
        </div>

        {state.phase === 'asking' && (
          <div className="td-consult-input">
            <input
              autoFocus
              placeholder="回答问题，回车提交"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
            />
            <button className="td-chip" onClick={skip}>
              跳过追问
            </button>
          </div>
        )}

        {state.phase === 'draft' && draft && (
          <div className="td-consult-foot">
            <button className="td-chip" onClick={close}>
              取消
            </button>
            <button className="td-chip is-on" onClick={() => adopt(draft)}>
              添加任务
            </button>
          </div>
        )}
        {state.phase === 'error' && (
          <div className="td-consult-foot">
            <button className="td-chip is-on" onClick={close}>
              关闭，改用快速添加
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/** 草稿字段编辑器。 */
const DraftEditor: React.FC<{ draft: ConsultDraft; onChange: (d: ConsultDraft) => void }> = ({ draft, onChange }) => {
  const set = (patch: Partial<ConsultDraft>) => onChange({ ...draft, ...patch });
  return (
    <div>
      <div className="td-consult-draft-row">
        <span className="td-label" style={{ flexShrink: 0 }}>标题</span>
        <input
          className="todo-panel__capture-input"
          style={{
            flex: 1, minWidth: 0, height: 26, border: 'none', borderRadius: 6,
            background: 'color-mix(in oklch, var(--color-text-primary) 8%, transparent)',
            color: 'var(--color-text-primary)', fontSize: 13, padding: '0 8px',
            outline: 'none', fontFamily: 'inherit',
          }}
          value={draft.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>
      <div className="td-chips" style={{ padding: '4px 8px' }}>
        <span className="td-label">截止</span>
        <input
          type="date"
          className="td-date-input"
          value={draft.due || ''}
          onChange={(e) => set({ due: e.target.value || null })}
        />
        <span className="td-label">提醒</span>
        <input
          type="time"
          className="td-date-input"
          value={draft.remindTime || ''}
          onChange={(e) => set({ remindTime: e.target.value || null })}
        />
        {draft.repeat && (
          <span className="td-repeat-mark">{REPEAT_LABELS[draft.repeat]}</span>
        )}
      </div>
      {draft.checklist.length > 0 && (
        <div style={{ padding: '2px 8px' }}>
          {draft.checklist.map((item, i) => (
            <div key={i} className="td-consult-draft-row" style={{ minHeight: 24 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>·</span>
              <span style={{ flex: 1 }}>{item}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * WorkbenchQueueDock — 运行中待处理输入的独立展示区（位于 transcript 与输入框之间）。
 *
 * 设计约束（见《工作台体验与 AI 交互提升计划》§3.3）：
 * - 队列项**不是**当前 transcript 的用户气泡：已排队/待插话的消息只在这里出现；
 * - Host 权威行（inbox 投影/session/state）才可编辑/删除/插话；本地提交中行只读；
 * - 一条直接展示，多条默认折叠计数；
 * - 不做拖拽排序（引擎 QueueAction 没有 reorder）。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ListOrdered, Pencil, Send, Trash2 } from 'lucide-react';

export interface QueueDockRow {
  /** 稳定 key：Host 行用 itemId，本地行用 requestId。 */
  key: string;
  text: string;
  placement: 'queued' | 'steering';
  status: 'sending' | 'accepted' | 'failed';
  /** Host 行才有：updateQueue 的目标 id。 */
  itemId?: string;
  error?: string;
}

export interface WorkbenchQueueDockProps {
  rows: QueueDockRow[];
  /** 点击「停止当前回合」时是否有后续排队会继续（用于说明停止的真实后果）。 */
  running: boolean;
  onEdit: (row: QueueDockRow, text: string) => void | Promise<void>;
  onRemove: (row: QueueDockRow) => void | Promise<void>;
  onSteer: (row: QueueDockRow) => void | Promise<void>;
  /** 本地失败项重试；Host 行不需要。 */
  onRetry?: (row: QueueDockRow) => void | Promise<void>;
  /** 逐项删除所有已对账的排队项（不停止当前回合）。 */
  onClearAll: (rows: QueueDockRow[]) => void | Promise<void>;
  /** 操作失败的汇总提示（由面板写入，dock 只展示）。 */
  actionError?: string | null;
}

export const WorkbenchQueueDock: React.FC<WorkbenchQueueDockProps> = ({
  rows,
  running,
  onEdit,
  onRemove,
  onSteer,
  onRetry,
  onClearAll,
  actionError,
}) => {
  const { t } = useTranslation('scenes/dsh');
  const [expanded, setExpanded] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // 条目回落（全部处理完）时收起，避免留下空壳
  useEffect(() => {
    if (rows.length === 0) {
      setExpanded(false);
      setEditingKey(null);
      setConfirmClear(false);
    }
  }, [rows.length]);

  if (rows.length === 0 && !actionError) return null;

  const hostRows = rows.filter(r => r.itemId && r.status !== 'failed');
  const single = rows.length === 1 ? rows[0] : null;
  const visible = expanded || rows.length === 1 ? rows : [];
  const statusLabel = (row: QueueDockRow): string => {
    if (row.status === 'sending') return t('chat.queueSending');
    if (row.status === 'failed') return t('chat.queueFailed');
    return row.placement === 'steering' ? t('chat.queueSteering') : t('chat.queueQueued');
  };

  const runAction = async (key: string, fn: () => void | Promise<void>): Promise<void> => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fn();
    } finally {
      setBusyKey(null);
    }
  };

  const startEdit = (row: QueueDockRow): void => {
    setEditingKey(row.key);
    setEditText(row.text);
  };

  const saveEdit = async (row: QueueDockRow): Promise<void> => {
    const text = editText.trim();
    if (!text) return;
    await runAction(row.key, async () => {
      await onEdit(row, text);
      setEditingKey(null);
    });
  };

  return (
    <div className="ai00-x-workbench-queue" aria-label={t('chat.queueTitle', { count: rows.length })}>
      <div className="ai00-x-workbench-queue__head">
        <button
          type="button"
          className="ai00-x-workbench-queue__toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded || rows.length === 1}
          aria-label={expanded ? t('chat.queueCollapse') : t('chat.queueExpand')}
          title={expanded ? t('chat.queueCollapse') : t('chat.queueExpand')}
        >
          {expanded || rows.length === 1 ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <ListOrdered size={12} />
          <span className="ai00-x-workbench-queue__title">
            {rows.length === 1 ? statusLabel(rows[0]) : t('chat.queueTitle', { count: rows.length })}
          </span>
        </button>
        {hostRows.length > 0 && (
          <button
            type="button"
            className={`ai00-x-workbench-queue__clear${confirmClear ? ' is-confirm' : ''}`}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                window.setTimeout(() => setConfirmClear(false), 4000);
                return;
              }
              setConfirmClear(false);
              void runAction('__clear', () => onClearAll(hostRows));
            }}
            title={t('chat.queueClearHint')}
          >
            {confirmClear ? t('chat.queueClearConfirm', { count: hostRows.length }) : t('chat.queueClear')}
          </button>
        )}
      </div>

      {running && hostRows.length > 0 && (
        <div className="ai00-x-workbench-queue__note">
          {t('chat.queueStopKeeps', { count: hostRows.length })}
        </div>
      )}

      {actionError && (
        <div className="ai00-x-workbench-queue__error" role="alert">
          {actionError}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="ai00-x-workbench-queue__list">
          {visible.map(row => {
            const isEditing = editingKey === row.key;
            const busy = busyKey === row.key;
            return (
              <li
                key={row.key}
                className={`ai00-x-workbench-queue__item is-${row.status}${
                  row.placement === 'steering' ? ' is-steering' : ''
                }`}
              >
                <div className="ai00-x-workbench-queue__body">
                  {isEditing ? (
                    <textarea
                      className="ai00-x-workbench-queue__editor"
                      value={editText}
                      rows={2}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void saveEdit(row);
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingKey(null);
                        }
                      }}
                      aria-label={t('chat.queueEdit')}
                    />
                  ) : (
                    <span className="ai00-x-workbench-queue__text">{row.text}</span>
                  )}
                  <span className="ai00-x-workbench-queue__status">{statusLabel(row)}</span>
                  {row.error && <span className="ai00-x-workbench-queue__item-error">{row.error}</span>}
                </div>
                <div className="ai00-x-workbench-queue__actions">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void saveEdit(row)}
                        disabled={busy || editText.trim().length === 0}
                      >
                        {t('chat.queueSave')}
                      </button>
                      <button type="button" onClick={() => setEditingKey(null)}>
                        {t('chat.queueCancel')}
                      </button>
                    </>
                  ) : row.status === 'failed' ? (
                    <>
                      {onRetry && (
                        <button type="button" onClick={() => void runAction(row.key, () => onRetry(row))}>
                          {t('chat.queueRetry')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void runAction(row.key, () => onRemove(row))}
                        aria-label={t('chat.queueRemove')}
                        title={t('chat.queueRemove')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  ) : row.itemId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(row)}
                        disabled={busy}
                        aria-label={t('chat.queueEdit')}
                        title={t('chat.queueEdit')}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void runAction(row.key, () => onSteer(row))}
                        disabled={busy || !running}
                        aria-label={t('chat.queueSteer')}
                        title={t('chat.queueSteer')}
                      >
                        <Send size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void runAction(row.key, () => onRemove(row))}
                        disabled={busy}
                        aria-label={t('chat.queueRemove')}
                        title={t('chat.queueRemove')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  ) : (
                    // 本地提交中：还没有 Host itemId，任何操作都不可用
                    <span className="ai00-x-workbench-queue__hint">{t('chat.queueSending')}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {single === null && !expanded && rows.length > 1 && (
        <div className="ai00-x-workbench-queue__preview">
          <span className="ai00-x-workbench-queue__text">{rows[0].text}</span>
        </div>
      )}
    </div>
  );
};

export default WorkbenchQueueDock;

/**
 * ShimHost — dialog-shim 的应用内弹窗宿主。
 *
 * confirm/alert → design-system ConfirmDialog（正规件，视觉合规）；
 * prompt → component-library Modal + Input，按 AGENTS.md 弹窗规范：
 * 内容 padding spacing-4、表单纵向 gap-3、按钮右对齐 gap-2 + 上分隔线。
 *
 * 关闭采用两段式：settle 先置空 pending（isOpen=false 走 Radix 正常关闭，
 * 清理 body 滚动/指针锁），保留 shown 一拍再卸载——直接卸载 open 状态的
 * Dialog 会残留 pointer-events: none 导致整页不可点击。
 */
import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, Input, Modal } from '@/component-library';
import type { PendingDialog } from './dialog-shim-host-types';
import './dialog-shim.scss';

export function ShimHost({
  pending,
  shown,
  onSettle,
}: {
  pending: PendingDialog | null;
  /** 最后一次展示的对话框（关闭动画期间保持挂载） */
  shown: PendingDialog | null;
  onSettle: (p: PendingDialog, ok: boolean, promptText: string) => void;
}): React.ReactElement | null {
  const dialog = pending ?? shown;
  const isOpen = Boolean(pending);
  const [value, setValue] = useState(dialog?.defaultValue ?? '');

  useEffect(() => {
    if (pending) setValue(pending.defaultValue);
  }, [pending]);

  if (!dialog) return null;

  const finish = (ok: boolean) => onSettle(dialog, ok, value);

  // prompt = Modal + 规范表单域（Input 组件，非 ConfirmDialog message 槽塞输入框）
  if (dialog.kind === 'prompt') {
    return (
      <Modal isOpen={isOpen} onClose={() => finish(false)} title="输入" size="small">
        <div className="ai00-dialog-shim__form">
          <div className="ai00-dialog-shim__message">{dialog.message}</div>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finish(true);
              if (e.key === 'Escape') finish(false);
            }}
            inputSize="small"
          />
          <div className="ai00-dialog-shim__actions">
            <Button variant="secondary" size="small" onClick={() => finish(false)}>
              取消
            </Button>
            <Button variant="primary" size="small" onClick={() => finish(true)}>
              确定
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  // confirm/alert → design-system ConfirmDialog
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={() => finish(false)}
      onConfirm={() => finish(true)}
      title={dialog.kind === 'confirm' ? '确认操作' : '提示'}
      message={dialog.message}
      type={dialog.kind === 'confirm' ? 'warning' : 'info'}
      confirmText={dialog.kind === 'alert' ? '好的' : '确定'}
      cancelText="取消"
      showCancel={dialog.kind === 'confirm'}
    />
  );
}

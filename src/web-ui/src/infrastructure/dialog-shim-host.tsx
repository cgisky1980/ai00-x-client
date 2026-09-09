/**
 * ShimHost — dialog-shim 的应用内弹窗宿主（ConfirmDialog 包一层输入态）。
 *
 * 由 dialog-shim.tsx 以模块级状态驱动：pending 作为 prop 传入，
 * 裁决回调 onSettle(pending, ok, promptText) 带回 prompt 输入值。
 */
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/component-library';

export type DialogKind = 'confirm' | 'alert' | 'prompt';

export interface PendingDialog {
  kind: DialogKind;
  message: string;
  defaultValue: string;
  resolve: (value: unknown) => void;
}

export function ShimHost({
  pending,
  onSettle,
}: {
  pending: PendingDialog | null;
  onSettle: (p: PendingDialog, ok: boolean, promptText: string) => void;
}): React.ReactElement | null {
  const [value, setValue] = useState(pending?.defaultValue ?? '');

  useEffect(() => {
    if (pending) setValue(pending.defaultValue);
  }, [pending]);

  if (!pending) return null;

  const finish = (ok: boolean) => onSettle(pending, ok, value);
  const kind = pending.kind;
  const title = kind === 'confirm' ? '确认操作' : kind === 'prompt' ? '输入' : '提示';

  return (
    <ConfirmDialog
      isOpen
      onClose={() => finish(false)}
      onConfirm={() => finish(true)}
      title={title}
      message={
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {pending.message}
          {kind === 'prompt' && (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finish(true);
                if (e.key === 'Escape') finish(false);
              }}
              style={{
                width: '100%',
                marginTop: 'var(--size-gap-2, 8px)',
                padding: 'var(--size-gap-1, 4px) var(--size-gap-2, 8px)',
                border: '1px solid var(--border-base, rgba(128,128,128,0.35))',
                borderRadius: 'var(--size-radius-sm, 6px)',
                background: 'var(--input-bg, transparent)',
                color: 'var(--color-text-primary, inherit)',
                fontSize: 'var(--font-size-sm, 13px)',
                outline: 'none',
              }}
            />
          )}
        </div>
      }
      type={kind === 'confirm' ? 'warning' : 'info'}
      confirmText={kind === 'alert' ? '好的' : '确定'}
      cancelText="取消"
    />
  );
}

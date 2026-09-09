/**
 * dialog-shim — 用应用内 ConfirmDialog 接管原生 window.confirm / prompt / alert。
 *
 * 背景：Tauri WebView 里原生 window.confirm 被 tauri-plugin-dialog 接管为
 * `plugin:dialog|confirm` IPC，未放行 ACL 的窗口直接 reject；且原生弹窗在
 * 穿透层（overlay）与浮层体系上破坏体验——产品裁定一律禁用原生弹窗。
 *
 * 全局安装后（installDialogShim，各窗口入口调用）：现存与未来的
 * window.confirm/prompt/alert 调用都走应用内弹窗（dialog-shim-host），返回
 * Promise——同步调用点必须 await（迁移时已全部改为 await）。
 */
import { createRoot, type Root } from 'react-dom/client';
import { ShimHost, type PendingDialog } from './dialog-shim-host';

let pending: PendingDialog | null = null;
let root: Root | null = null;
let installed = false;

function settle(p: PendingDialog, ok: boolean, promptText: string): void {
  pending = null;
  if (p.kind === 'confirm') p.resolve(ok);
  else if (p.kind === 'alert') p.resolve(undefined);
  else p.resolve(ok ? promptText : null);
  render();
}

function render(): void {
  root?.render(<ShimHost pending={pending} onSettle={settle} />);
}

function open(kind: PendingDialog['kind'], message: string, defaultValue: string): Promise<unknown> {
  return new Promise((resolve) => {
    // 同时只保留一个活跃弹窗：后到的直接裁决前一个（false/null），避免叠窗
    if (pending) settle(pending, false, pending.defaultValue);
    pending = { kind, message, defaultValue, resolve };
    render();
  });
}

/**
 * 全局安装（幂等）：覆写 window.confirm/prompt/alert。各窗口入口各调一次。
 * 注意：window.confirm/prompt 的 TS 类型仍标为同步 boolean/string——
 * 调用点必须 await，否则拿到的是 Promise 对象（恒真值）。
 */
export function installDialogShim(): void {
  if (installed) return;
  installed = true;

  const mount = () => {
    if (root) return;
    const host = document.createElement('div');
    host.id = 'ai00-dialog-shim';
    document.body.appendChild(host);
    root = createRoot(host);
    render();
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  window.confirm = ((message?: string) =>
    open('confirm', String(message ?? ''), '') as Promise<boolean>) as unknown as typeof window.confirm;
  window.prompt = ((message?: string, defaultResponse?: string) =>
    open('prompt', String(message ?? ''), String(defaultResponse ?? '')) as Promise<string | null>) as unknown as typeof window.prompt;
  window.alert = ((message?: string) => {
    void open('alert', String(message ?? ''), '');
  }) as unknown as typeof window.alert;
}

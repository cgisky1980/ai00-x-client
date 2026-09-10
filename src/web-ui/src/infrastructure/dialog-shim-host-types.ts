/**
 * PendingDialog —— dialog-shim 宿主与逻辑层共享的挂起弹窗描述。
 * 独立文件以保持 dialog-shim.tsx 纯逻辑（无组件导出，react-refresh 合规）。
 */
export interface PendingDialog {
  kind: 'confirm' | 'alert' | 'prompt';
  message: string;
  defaultValue: string;
  resolve: (value: unknown) => void;
}

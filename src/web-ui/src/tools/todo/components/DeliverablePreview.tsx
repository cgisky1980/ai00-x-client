/**
 * 交付物预览弹窗：把「工作台中区文件预览」装进 Modal，
 * 供策窗口计划面板「交付物」抽屉点击产物链接预览。
 *
 * 分流与读取逻辑只有一份，见 `WorkbenchFilePreview`（避免两套预览分叉）。
 */
import React from 'react';
import { Modal } from '@/component-library';
import { WorkbenchFilePreview } from '@/app/scenes/workbench/WorkbenchFilePreview';
import { baseName } from '@/app/scenes/workbench/useWorkbenchTabs';

export interface DeliverablePreviewProps {
  /** 预览的文件绝对路径；null = 关闭 */
  path: string | null;
  onClose: () => void;
}

export const DeliverablePreview: React.FC<DeliverablePreviewProps> = ({ path, onClose }) => (
  <Modal
    isOpen={!!path}
    onClose={onClose}
    title={path ? `预览 · ${baseName(path)}` : ''}
    size="xlarge"
  >
    {path && (
      <div className="ai00-x-wb-preview-modal">
        <WorkbenchFilePreview path={path} showToolbar={false} />
      </div>
    )}
  </Modal>
);

export default DeliverablePreview;

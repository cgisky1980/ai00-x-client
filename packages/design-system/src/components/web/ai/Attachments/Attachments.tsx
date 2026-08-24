/**
 * Attachments —— AI 附件列表（v0.15 AI 系，antd X Attachments 对位）
 * image=缩略网格；file=图标+名+尺寸行；uploading 骨架；可移除。
 */
import React from 'react';
import { label } from '../../../../lib/labels';
import './Attachments.scss';

export interface AttachmentItem {
  id: string;
  name: string;
  type: 'image' | 'file';
  size?: string;
  url?: string;
}

export interface AttachmentsProps {
  items: AttachmentItem[];
  onRemove?(id: string): void;
  /** 上传中的 id 集合（显示骨架） */
  uploadingIds?: string[];
  className?: string;
}

const FileIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" className="ai-attachments__file-icon" aria-hidden="true">
    <path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
    <path d="M9.5 1.5V5H13" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
  </svg>
);

export const Attachments: React.FC<AttachmentsProps> = ({
  items,
  onRemove,
  uploadingIds,
  className = '',
}) => {
  if (items.length === 0) return null;
  const uploading = new Set(uploadingIds ?? []);

  return (
    <div className={['ai-attachments', className].filter(Boolean).join(' ')}>
      {items.map((item) => {
        const isUploading = uploading.has(item.id);
        return (
          <div key={item.id} className={`ai-attachments__item ai-attachments__item--${item.type}`}>
            {item.type === 'image' ? (
              isUploading ? (
                <span className="ai-attachments__thumb is-loading" aria-label={label('components.ai.uploading', '上传中')} />
              ) : (
                <img className="ai-attachments__thumb" src={item.url} alt={item.name} />
              )
            ) : (
              <span className="ai-attachments__file">
                <FileIcon />
                <span className="ai-attachments__file-name">{item.name}</span>
                {item.size != null && <span className="ai-attachments__file-size">{item.size}</span>}
              </span>
            )}
            {onRemove && (
              <button
                type="button"
                className="ai-attachments__remove"
                aria-label={`${label('components.ai.remove', '移除')} ${item.name}`}
                onClick={() => onRemove(item.id)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

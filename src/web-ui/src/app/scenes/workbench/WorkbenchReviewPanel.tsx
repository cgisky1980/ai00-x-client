/**
 * WorkbenchReviewPanel — 交付验收档位（输入框内）。
 *
 * 与「提问」「计划评审」共用 `ComposerInteraction` 骨架：人类介入永远贴着输入框，
 * 消息流里只留「已提交/已验收」这类事实记录。
 *
 * - 通过 → `completeTask`，流程条三段全绿；
 * - 退回 → 清掉自检标记，回到执行态，人类在对话里说明问题。
 */
import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { InputDialog } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TodoTask } from '@/tools/todo/api/types';
import { ComposerInteraction } from './ComposerInteraction';
import './WorkbenchReviewPanel.scss';

export interface WorkbenchReviewPanelProps {
  task: TodoTask;
  /** 计划书正文（有就摘首行做要点）。 */
  planMd?: string | null;
  onApprove: () => void;
  /** 退回重做：带用户填写的返工意见（会随消息发回会话）。 */
  onReject: (reason: string) => void;
}

export const WorkbenchReviewPanel: React.FC<WorkbenchReviewPanelProps> = ({
  task,
  planMd,
  onApprove,
  onReject,
}) => {
  const { t } = useI18n('common');
  const [rejectOpen, setRejectOpen] = useState(false);
  const deliverables = (task.deliverables ?? []).slice(0, 4);
  const overflow = (task.deliverables?.length ?? 0) - deliverables.length;
  const planHead = (planMd ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);

  return (
    <>
    <ComposerInteraction
      tone="warning"
      meta={
        deliverables.length > 0
          ? t('nav.workbenchWindow.review.count', { count: task.deliverables?.length ?? 0 })
          : undefined
      }
      actions={[
        {
          label: t('nav.workbenchWindow.review.reject'),
          onClick: () => setRejectOpen(true),
          variant: 'secondary',
        },
        { label: t('nav.workbenchWindow.review.approve'), onClick: onApprove, variant: 'primary' },
      ]}
    >
      {planHead && (
        <p className="ai00-x-review-line" title={planHead}>
          <FileText size={12} aria-hidden />
          <span>{planHead}</span>
        </p>
      )}
      <div className="ai00-x-review-deps">
        {deliverables.length === 0 ? (
          <span className="ai00-x-review-empty">
            {t('nav.workbenchWindow.review.noDeliverables')}
          </span>
        ) : (
          deliverables.map((item) => (
            <span key={item} className="ai00-x-review-item" title={item}>
              {item}
            </span>
          ))
        )}
        {overflow > 0 && (
          <span className="ai00-x-review-more">
            {t('nav.workbenchWindow.review.more', { count: overflow })}
          </span>
        )}
      </div>
    </ComposerInteraction>
    {/* 退回必须带意见：否则 agent 不知道改什么，用户还要再打一遍 */}
    <InputDialog
      isOpen={rejectOpen}
      onClose={() => setRejectOpen(false)}
      onConfirm={(value) => {
        setRejectOpen(false);
        onReject(value.trim() || t('nav.workbenchWindow.board.rejectDefault'));
      }}
      title={t('nav.workbenchWindow.review.reject')}
      description={t('nav.workbenchWindow.board.rejectPrompt')}
      defaultValue={t('nav.workbenchWindow.board.rejectDefault')}
      confirmText={t('nav.workbenchWindow.review.reject')}
    />
    </>
  );
};

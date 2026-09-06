/**
 * CommentItem — 评论行
 *
 * 头像/昵称/相对时间/内容（pre-wrap）；回复带 @昵称 前缀；
 * 软删行显示占位（「留言已删除」）。删除权限 = 评论作者 / 帖主 / 超管。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Avatar } from '@/component-library';
import { CornerUpLeft } from 'lucide-react';
import type { CommunityComment } from './communityApi';
import { formatRelTime } from './time';

export const CommentItem: React.FC<{
  comment: CommunityComment;
  /** 我自己的 member id（删权判定） */
  myMemberId: number | null;
  /** 我是帖主或超管（额外删权） */
  canModerate: boolean;
  onReply: (c: CommunityComment) => void;
  onDelete: (c: CommunityComment) => void;
}> = ({ comment, myMemberId, canModerate, onReply, onDelete }) => {
  const { t } = useI18n();
  const displayName = comment.nickname || comment.username;
  const canDelete =
    !comment.deleted_at &&
    (comment.member_id === myMemberId || canModerate);

  if (comment.deleted_at) {
    return (
      <div className="community-comment community-comment--deleted">
        <span>{t('community.commentDeleted', { defaultValue: '留言已删除' })}</span>
      </div>
    );
  }

  return (
    <div className="community-comment">
      <Avatar name={displayName} size="sm" src={comment.avatar || undefined} />
      <div className="community-comment__body">
        <div className="community-comment__meta">
          <span className="community-comment__name">{displayName}</span>
          <span className="community-comment__time ds-data">{formatRelTime(comment.created_at)}</span>
        </div>
        <p className="community-comment__content">
          {comment.reply_to != null && comment.reply_to_name && (
            <span className="community-comment__reply-to">@{comment.reply_to_name} </span>
          )}
          {comment.content}
        </p>
        <div className="community-comment__ops">
          <button type="button" className="community-comment__op" onClick={() => onReply(comment)}>
            <CornerUpLeft size={12} aria-hidden />
            {t('community.reply', { defaultValue: '回复' })}
          </button>
          {canDelete && (
            <button type="button" className="community-comment__op" onClick={() => onDelete(comment)}>
              {t('community.delete', { defaultValue: '删除' })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

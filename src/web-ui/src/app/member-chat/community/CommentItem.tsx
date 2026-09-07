/**
 * CommentItem — 评论行
 *
 * 头像/昵称/相对时间/内容（pre-wrap）；回复带 @昵称 前缀；
 * 软删行显示占位（「留言已删除」）。删除权限 = 评论作者 / 帖主 / 超管。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { MemberAvatar } from '../components/MemberAvatar';
import { CornerUpLeft, Heart } from 'lucide-react';
import { useCommunityStore } from './communityStore';
import { resolveMentionId, splitMentionParts } from './mention';
import type { CommunityComment } from './communityApi';
import { formatRelTime } from './time';

/** 评论正文：@提及 渲染为可点 chip（点击打开对方主页），其余纯文本 */
const MentionText: React.FC<{ text: string }> = ({ text }) => {
  const openProfile = useCommunityStore((s) => s.openProfile);
  const parts = splitMentionParts(text);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'mention' ? (
          <button
            key={i}
            type="button"
            className="community-mention-chip"
            onClick={() => {
              void resolveMentionId(p.name).then((id) => {
                if (id != null) openProfile(id);
              });
            }}
          >
            @{p.name}
          </button>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </>
  );
};

export const CommentItem: React.FC<{
  comment: CommunityComment;
  /** 我自己的 member id（删权判定） */
  myMemberId: number | null;
  /** 我是帖主或超管（额外删权） */
  canModerate: boolean;
  onReply: (c: CommunityComment) => void;
  onDelete: (c: CommunityComment) => void;
}> = ({ comment, myMemberId, canModerate, onReply, onDelete }) => {
  const { t } = useI18n('community');
  const toggleCommentLike = useCommunityStore((s) => s.toggleCommentLike);
  const displayName = comment.nickname || comment.username;
  const canDelete =
    !comment.deleted_at &&
    (comment.member_id === myMemberId || canModerate);

  if (comment.deleted_at) {
    return (
      <div className="community-comment community-comment--deleted">
        <span>{t('commentDeleted', { defaultValue: '留言已删除' })}</span>
      </div>
    );
  }

  return (
    <div className="community-comment">
      <MemberAvatar name={displayName} size="sm" data={comment.avatar} />
      <div className="community-comment__body">
        <div className="community-comment__meta">
          <span className="community-comment__name">{displayName}</span>
          <span className="community-comment__time ds-data">{formatRelTime(comment.created_at)}</span>
        </div>
        <p className="community-comment__content">
          {comment.reply_to != null && comment.reply_to_name && (
            <span className="community-comment__reply-to">@{comment.reply_to_name} </span>
          )}
          <MentionText text={comment.content} />
        </p>
        <div className="community-comment__ops">
          <button type="button" className="community-comment__op" onClick={() => onReply(comment)}>
            <CornerUpLeft size={12} aria-hidden />
            {t('reply', { defaultValue: '回复' })}
          </button>
          {canDelete && (
            <button type="button" className="community-comment__op" onClick={() => onDelete(comment)}>
              {t('delete', { defaultValue: '删除' })}
            </button>
          )}
          <button
            type="button"
            className={`community-comment__op ${comment.liked_by_me ? 'is-liked' : ''}`}
            onClick={() => void toggleCommentLike(comment)}
            aria-pressed={comment.liked_by_me}
            aria-label={t('like', { defaultValue: '点赞' })}
          >
            <Heart
              size={12}
              aria-hidden
              fill={comment.liked_by_me ? 'currentColor' : 'none'}
            />
            <span className="ds-data">{comment.like_count > 0 ? comment.like_count : ''}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

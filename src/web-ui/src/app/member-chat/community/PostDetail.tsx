/**
 * PostDetail — 动态详情 + 留言（评论）
 *
 * 顶部返回（逐级返回栈）；帖子卡复用 PostCard（点赞/编辑/删除/媒体）；
 * 留言区：CommentItem 列表 + 底部输入（回复带 @昵称 前缀 chip，Enter 发送）。
 * 删除权限：评论作者 / 帖主 / 超管。
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton, Skeleton, toastError, toastSuccess } from '@/component-library';
import { ArrowLeft, CornerUpLeft, SendHorizontal, X } from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { confirmDialog } from '@/component-library';
import { useCommunityStore } from './communityStore';
import { PostCard } from './PostCard';
import { CommentItem } from './CommentItem';
import { MentionInput } from './MentionInput';
import type { CommunityComment } from './communityApi';

export const PostDetail: React.FC = () => {
  const { t } = useI18n('community');
  const detailPost = useCommunityStore((s) => s.detailPost);
  const comments = useCommunityStore((s) => s.comments);
  const commentsLoading = useCommunityStore((s) => s.commentsLoading);
  const back = useCommunityStore((s) => s.back);
  const createComment = useCommunityStore((s) => s.createComment);
  const commentsHasMore = useCommunityStore((s) => s.commentsHasMore);
  const loadMoreComments = useCommunityStore((s) => s.loadMoreComments);
  const deleteComment = useCommunityStore((s) => s.deleteComment);

  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const isSuperAdmin = useMemberChatStore((s) => s.session?.isSuperAdmin ?? false);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<CommunityComment | null>(null);
  const [sending, setSending] = useState(false);

  if (!detailPost) return null;
  const canModerate = detailPost.member_id === myMemberId || isSuperAdmin;

  const submit = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    const ok = await createComment(content, replyTo?.id);
    setSending(false);
    if (ok) {
      setDraft('');
      setReplyTo(null);
    } else {
      toastError(t('commentFailed', { defaultValue: '留言失败，请重试' }));
    }
  };

  const onDelete = async (c: CommunityComment) => {
    const ok = await confirmDialog({
      title: t('deleteCommentTitle', { defaultValue: '删除留言' }),
      message: t('deleteCommentMessage', { defaultValue: '确定删除这条留言吗？' }),
      confirmDanger: true,
    });
    if (ok) {
      void deleteComment(c.id);
      toastSuccess(t('commentDeletedDone', { defaultValue: '留言已删除' }));
    }
  };

  return (
    <div className="community-detail">
      <header className="community-detail__topbar">
        <IconButton
          variant="ghost"
          shape="square"
          tooltip={t('back', { defaultValue: '返回' })}
          aria-label={t('back', { defaultValue: '返回' })}
          onClick={back}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <span className="community-detail__title">
          {t('detailTitle', { defaultValue: '动态详情' })}
        </span>
      </header>

      <div className="community-detail__scroll">
        <PostCard post={detailPost} rich />

        <section className="community-detail__comments" aria-label={t('comments', { defaultValue: '留言' })}>
          <h3 className="community-detail__comments-head ds-data">
            {t('commentsCount', { defaultValue: '留言 {{n}}', n: detailPost.comment_count })}
          </h3>
          {commentsLoading ? (
            <div className="community-detail__comments-loading" aria-hidden>
              <Skeleton style={{ height: 44 }} />
              <Skeleton style={{ height: 44 }} />
            </div>
          ) : comments.length === 0 ? (
            <Empty
              title={t('commentsEmpty', { defaultValue: '还没有留言' })}
              description={t('commentsEmptyHint', { defaultValue: '说点什么吧' })}
            />
          ) : (
            comments.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                myMemberId={myMemberId}
                canModerate={canModerate}
                onReply={(cc) => setReplyTo(cc)}
                onDelete={(cc) => void onDelete(cc)}
              />
            ))
          )}
          {commentsHasMore && (
            <button
              type="button"
              className="community-detail__comments-more"
              onClick={() => void loadMoreComments()}
            >
              {t('loadMoreComments', { defaultValue: '加载更多留言' })}
            </button>
          )}
        </section>
      </div>

      <footer className="community-detail__composer">
        {replyTo && (
          <span className="community-detail__reply-chip">
            <CornerUpLeft size={12} aria-hidden />
            {t('replyTo', { defaultValue: '回复' })} @{replyTo.nickname || replyTo.username}
            <button
              type="button"
              className="community-detail__reply-clear"
              aria-label={t('cancelReply', { defaultValue: '取消回复' })}
              onClick={() => setReplyTo(null)}
            >
              <X size={10} />
            </button>
          </span>
        )}
        <div className="community-detail__composer-row">
          <MentionInput
            className="community-detail__input"
            value={draft}
            onChange={setDraft}
            onEnter={() => void submit()}
            placeholder={t('commentPlaceholder', { defaultValue: '友善留言…' })}
            maxLength={500}
            ariaLabel={t('commentPlaceholder', { defaultValue: '友善留言…' })}
            disabled={sending}
          />
          <Button
            variant="primary"
            size="small"
            isLoading={sending}
            disabled={!draft.trim()}
            onClick={() => void submit()}
            aria-label={t('send', { defaultValue: '发送' })}
          >
            <SendHorizontal size={14} aria-hidden />
          </Button>
        </div>
      </footer>
    </div>
  );
};

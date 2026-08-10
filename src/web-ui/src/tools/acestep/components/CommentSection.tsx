/**
 * CommentSection — 分享详情对话框的评论区。
 *
 * 接收 `shareId`，自动从 `useShareStore` 加载评论列表 + 当前用户 member_id。
 * 提供：
 *   - 添加评论表单（textarea + 提交按钮，需登录）
 *   - 评论列表（每条显示作者/日期/内容/已编辑标记 + 回复/编辑/删除按钮）
 *   - 内联编辑表单（点击 Edit 后切换为 textarea）
 *   - 内联回复表单（点击 Reply 后在评论下方显示 textarea）
 *
 * **作者校验**：仅当 `comment.memberId === currentMemberId` 时显示编辑/删除按钮。
 * 未登录时（currentMemberId === null）只显示评论列表，不显示添加表单。
 *
 * **评论层级**：后端返回平铺列表（parent_id 表示回复关系）。回复
 * （parent_id !== null）通过 CSS 缩进显示，不重新分组。
 *
 * **性能**：评论列表用 `CommentItem` 子组件 + `React.memo` 包装，避免父组件
 * 输入框值变化时重渲染所有评论。父组件用 `useCallback` 包装所有回调保持引用稳定。
 *
 * **a11y**：所有错误提示用 `role="alert"` + `aria-live="polite"`，屏幕阅读器
 * 可主动播报动态出现的错误。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { useShareStore } from '../store/shareStore';
import type { ShareComment } from '../services/ShareService';
import './CommentSection.scss';

/** `t` 函数类型：从 useI18n 返回类型推断，避免 i18next TFunction brand 不兼容问题。 */
type I18nT = ReturnType<typeof useI18n>['t'];

/** 格式化 RFC3339 时间字符串为 `YYYY-MM-DD HH:mm`。 */
function formatDateTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!ts) return '';
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** 输入错误状态：标记错误出现在哪个表单 + 错误信息。同一时间仅一个错误。 */
interface InputError {
  field: 'new' | 'reply' | 'edit';
  message: string;
}

export interface CommentSectionProps {
  /** 分享 ID（用于加载评论 + 提交评论操作） */
  shareId: string;
}

// ============================================================================
// CommentItem — 单条评论子组件（React.memo 包装，避免父组件输入时重渲染）
// ============================================================================

interface CommentItemProps {
  comment: ShareComment;
  currentMemberId: number | null;
  commentSubmitting: boolean;
  editingId: number | null;
  replyToId: number | null;
  replyingToName: string;
  editContent: string;
  replyContent: string;
  editTooLong: boolean;
  replyTooLong: boolean;
  /** 编辑表单的错误信息（仅当 editingId === comment.id 时可能非 null） */
  editFormError: string | null;
  /** 回复表单的错误信息（仅当 replyToId === comment.id 时可能非 null） */
  replyFormError: string | null;
  // 回调（父组件用 useCallback 包装保持引用稳定）
  onEditContentChange: (v: string) => void;
  onReplyContentChange: (v: string) => void;
  onStartEdit: (comment: ShareComment) => void;
  onStartReply: (comment: ShareComment) => void;
  onCancelEdit: () => void;
  onCancelReply: () => void;
  onEdit: (commentId: number) => void;
  onReply: () => void;
  onDelete: (commentId: number) => void;
  t: I18nT;
}

const CommentItem = React.memo(
  function CommentItem(props: CommentItemProps) {
    const {
      comment,
      currentMemberId,
      commentSubmitting,
      editingId,
      replyToId,
      replyingToName,
      editContent,
      replyContent,
      editTooLong,
      replyTooLong,
      editFormError,
      replyFormError,
      onEditContentChange,
      onReplyContentChange,
      onStartEdit,
      onStartReply,
      onCancelEdit,
      onCancelReply,
      onEdit,
      onReply,
      onDelete,
      t,
    } = props;

    const isReply = comment.parentId !== null;
    const isAuthor = currentMemberId !== null && currentMemberId === comment.memberId;
    const isEditing = editingId === comment.id;
    const isReplying = replyToId === comment.id;

    return (
      <li className={`comment-section__item${isReply ? ' is-reply' : ''}`}>
        {/* 编辑模式 */}
        {isEditing ? (
          <div className="comment-section__edit-form">
            <textarea
              className="comment-section__textarea"
              value={editContent}
              onChange={(e) => onEditContentChange(e.target.value)}
              maxLength={2000}
              disabled={commentSubmitting}
              rows={3}
              aria-invalid={editFormError !== null}
            />
            {(editTooLong || editFormError !== null) && (
              <p className="comment-section__error" role="alert" aria-live="polite">
                <AlertCircle size={12} />
                <span>
                  {editFormError ??
                    t('share.comment.contentTooLong', { defaultValue: 'Comment must be 1-2000 characters' })}
                </span>
              </p>
            )}
            <div className="comment-section__form-actions">
              <Button variant="ghost" size="small" onClick={onCancelEdit} disabled={commentSubmitting}>
                {t('share.comment.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button
                variant="primary"
                size="small"
                onClick={() => onEdit(comment.id)}
                disabled={commentSubmitting || !editContent.trim() || editTooLong}
              >
                {commentSubmitting
                  ? t('share.comment.saving', { defaultValue: 'Saving...' })
                  : t('share.comment.save', { defaultValue: 'Save' })}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* 评论内容 */}
            <div className="comment-section__item-header">
              <span className="comment-section__item-author">{comment.memberName}</span>
              <span className="comment-section__item-date">{formatDateTime(comment.createdAt)}</span>
              {comment.editedAt && (
                <span className="comment-section__item-edited">
                  {t('share.comment.edited', { defaultValue: '(edited)' })}
                </span>
              )}
            </div>
            <div className="comment-section__item-content">{comment.content}</div>

            {/* 操作按钮 */}
            <div className="comment-section__item-actions">
              {currentMemberId !== null && (
                <button type="button" onClick={() => onStartReply(comment)}>
                  {t('share.comment.reply', { defaultValue: 'Reply' })}
                </button>
              )}
              {isAuthor && (
                <>
                  <button type="button" onClick={() => onStartEdit(comment)}>
                    {t('share.comment.edit', { defaultValue: 'Edit' })}
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => onDelete(comment.id)}
                  >
                    {t('share.comment.delete', { defaultValue: 'Delete' })}
                  </button>
                </>
              )}
            </div>

            {/* 回复表单 */}
            {isReplying && (
              <div className="comment-section__reply-form">
                <p className="comment-section__replying-to">
                  {t('share.comment.replyingTo', {
                    name: replyingToName,
                    defaultValue: 'Replying to {{name}}',
                  })}
                </p>
                <textarea
                  className="comment-section__textarea"
                  value={replyContent}
                  onChange={(e) => onReplyContentChange(e.target.value)}
                  placeholder={t('share.comment.placeholder', { defaultValue: 'Write a comment...' })}
                  maxLength={2000}
                  disabled={commentSubmitting}
                  rows={3}
                  aria-invalid={replyFormError !== null}
                />
                {(replyTooLong || replyFormError !== null) && (
                  <p className="comment-section__error" role="alert" aria-live="polite">
                    <AlertCircle size={12} />
                    <span>
                      {replyFormError ??
                        t('share.comment.contentTooLong', {
                          defaultValue: 'Comment must be 1-2000 characters',
                        })}
                    </span>
                  </p>
                )}
                <div className="comment-section__form-actions">
                  <Button variant="ghost" size="small" onClick={onCancelReply} disabled={commentSubmitting}>
                    {t('share.comment.cancel', { defaultValue: 'Cancel' })}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={onReply}
                    disabled={commentSubmitting || !replyContent.trim() || replyTooLong}
                  >
                    {commentSubmitting
                      ? t('share.comment.submitting', { defaultValue: 'Posting...' })
                      : t('share.comment.submit', { defaultValue: 'Post' })}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </li>
    );
  },
  // 自定义比较函数：仅当关键 props 变化时重渲染
  (prev, next) => {
    return (
      prev.comment === next.comment &&
      prev.currentMemberId === next.currentMemberId &&
      prev.commentSubmitting === next.commentSubmitting &&
      prev.editingId === next.editingId &&
      prev.replyToId === next.replyToId &&
      prev.replyingToName === next.replyingToName &&
      prev.editContent === next.editContent &&
      prev.replyContent === next.replyContent &&
      prev.editTooLong === next.editTooLong &&
      prev.replyTooLong === next.replyTooLong &&
      prev.editFormError === next.editFormError &&
      prev.replyFormError === next.replyFormError
    );
  },
);

export const CommentSection: React.FC<CommentSectionProps> = ({ shareId }) => {
  const { t } = useI18n('acestep');
  const {
    comments,
    commentsLoading,
    commentsError,
    currentMemberId,
    commentSubmitting,
    commentsTotal,
    commentsSort,
    loadComments,
    loadMoreComments,
    setCommentsSort,
    addComment,
    editComment,
    deleteComment,
    loadCurrentMemberId,
    clearComments,
    clearCommentsError,
  } = useShareStore();

  // ---- 本地 UI 状态 ----
  const [newComment, setNewComment] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: number; name: string } | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  // F-07: 输入校验错误（空内容 / 超长）。本地 state，unmount 后丢弃可接受。
  const [inputError, setInputError] = useState<InputError | null>(null);

  // 加载评论 + 当前 member_id；卸载时清空评论状态
  useEffect(() => {
    loadComments(shareId);
    loadCurrentMemberId();
    return () => {
      clearComments();
    };
  }, [shareId, loadComments, loadCurrentMemberId, clearComments]);

  // ---- 切换排序 ----
  const handleSortChange = useCallback(
    (sort: 'asc' | 'desc') => {
      if (sort === commentsSort) return;
      setCommentsSort(sort);
      // 重置 offset=0 重新加载（覆盖式）
      loadComments(shareId, 50, 0, sort);
    },
    [commentsSort, setCommentsSort, loadComments, shareId],
  );

  // ---- 添加评论 ----
  const handleSubmit = useCallback(async () => {
    const trimmed = newComment.trim();
    if (!trimmed) {
      setInputError({
        field: 'new',
        message: t('share.comment.emptyContent', { defaultValue: 'Comment cannot be empty' }),
      });
      return;
    }
    if (trimmed.length > 2000) {
      setInputError({
        field: 'new',
        message: t('share.comment.contentTooLong', { defaultValue: 'Comment must be 1-2000 characters' }),
      });
      return;
    }
    setInputError(null);
    try {
      await addComment(shareId, trimmed);
      setNewComment('');
    } catch {
      // 错误已存入 store，UI 显示
    }
  }, [newComment, t, addComment, shareId]);

  // ---- 回复评论 ----
  const handleReply = useCallback(async () => {
    if (!replyTo) return;
    const trimmed = replyContent.trim();
    if (!trimmed) {
      setInputError({
        field: 'reply',
        message: t('share.comment.emptyContent', { defaultValue: 'Comment cannot be empty' }),
      });
      return;
    }
    if (trimmed.length > 2000) {
      setInputError({
        field: 'reply',
        message: t('share.comment.contentTooLong', { defaultValue: 'Comment must be 1-2000 characters' }),
      });
      return;
    }
    setInputError(null);
    try {
      await addComment(shareId, trimmed, replyTo.id);
      setReplyContent('');
      setReplyTo(null);
    } catch {
      // 错误已存入 store
    }
  }, [replyTo, replyContent, t, addComment, shareId]);

  // ---- 编辑评论 ----
  const handleEdit = useCallback(
    async (commentId: number) => {
      const trimmed = editContent.trim();
      if (!trimmed) {
        setInputError({
          field: 'edit',
          message: t('share.comment.emptyContent', { defaultValue: 'Comment cannot be empty' }),
        });
        return;
      }
      if (trimmed.length > 2000) {
        setInputError({
          field: 'edit',
          message: t('share.comment.contentTooLong', { defaultValue: 'Comment must be 1-2000 characters' }),
        });
        return;
      }
      setInputError(null);
      try {
        await editComment(shareId, commentId, trimmed);
        setEditingId(null);
        setEditContent('');
      } catch {
        // 错误已存入 store
      }
    },
    [editContent, t, editComment, shareId],
  );

  // ---- 删除评论 ----
  const handleDelete = useCallback(
    async (commentId: number) => {
      const confirmed = window.confirm(
        t('share.comment.confirmDelete', { defaultValue: 'Delete this comment?' }),
      );
      if (!confirmed) return;
      try {
        await deleteComment(shareId, commentId);
      } catch {
        // 错误已存入 store
      }
    },
    [t, deleteComment, shareId],
  );

  // ---- 进入编辑/回复模式 ----
  const startEdit = useCallback((comment: ShareComment) => {
    setEditingId(comment.id);
    setEditContent(comment.content);
    // 退出回复模式（互斥）
    setReplyTo(null);
    setReplyContent('');
    setInputError(null);
  }, []);

  const startReply = useCallback((comment: ShareComment) => {
    setReplyTo({ id: comment.id, name: comment.memberName });
    setReplyContent('');
    // 退出编辑模式（互斥）
    setEditingId(null);
    setEditContent('');
    setInputError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditContent('');
    setInputError(null);
  }, []);

  const cancelReply = useCallback(() => {
    setReplyTo(null);
    setReplyContent('');
    setInputError(null);
  }, []);

  const newCommentTooLong = newComment.length > 2000;
  const replyTooLong = replyContent.length > 2000;
  const editTooLong = editContent.length > 2000;

  return (
    <div className="comment-section">
      <h3 className="comment-section__title">
        <MessageSquare size={14} />
        <span>{t('share.comment.title', { defaultValue: 'Comments' })}</span>
        {commentsTotal > 0 && <span className="comment-section__count">{commentsTotal}</span>}
        {/* 排序切换：最新 / 最早 */}
        {comments.length > 0 && (
          <div
            className="comment-section__sort"
            role="group"
            aria-label={t('share.comment.sortAria', { defaultValue: 'Sort comments' })}
          >
            <button
              type="button"
              className={`comment-section__sort-btn${commentsSort === 'desc' ? ' is-active' : ''}`}
              onClick={() => handleSortChange('desc')}
              disabled={commentsLoading}
              aria-pressed={commentsSort === 'desc'}
            >
              {t('share.comment.sortNewest', { defaultValue: 'Newest' })}
            </button>
            <button
              type="button"
              className={`comment-section__sort-btn${commentsSort === 'asc' ? ' is-active' : ''}`}
              onClick={() => handleSortChange('asc')}
              disabled={commentsLoading}
              aria-pressed={commentsSort === 'asc'}
            >
              {t('share.comment.sortOldest', { defaultValue: 'Oldest' })}
            </button>
          </div>
        )}
      </h3>

      {/* 添加评论表单 / 登录提示 */}
      {currentMemberId === null ? (
        <p className="comment-section__login-required">
          {t('share.comment.loginRequired', { defaultValue: 'Please log in to comment' })}
        </p>
      ) : (
        <div className="comment-section__form">
          <textarea
            className="comment-section__textarea"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder={t('share.comment.placeholder', { defaultValue: 'Write a comment...' })}
            maxLength={2000}
            disabled={commentSubmitting}
            rows={3}
            aria-invalid={inputError?.field === 'new'}
          />
          {(newCommentTooLong || inputError?.field === 'new') && (
            <p className="comment-section__error" role="alert" aria-live="polite">
              <AlertCircle size={12} />
              <span>
                {inputError?.field === 'new'
                  ? inputError.message
                  : t('share.comment.contentTooLong', { defaultValue: 'Comment must be 1-2000 characters' })}
              </span>
            </p>
          )}
          <div className="comment-section__form-actions">
            <Button
              variant="primary"
              size="small"
              onClick={handleSubmit}
              disabled={commentSubmitting || !newComment.trim() || newCommentTooLong}
            >
              {commentSubmitting
                ? t('share.comment.submitting', { defaultValue: 'Posting...' })
                : t('share.comment.submit', { defaultValue: 'Post' })}
            </Button>
          </div>
        </div>
      )}

      {/* 错误提示（store 层错误，如加载/提交失败） */}
      {commentsError && (
        <div className="comment-section__error" role="alert" aria-live="polite">
          <AlertCircle size={12} />
          <span>{commentsError}</span>
          <button type="button" onClick={clearCommentsError} aria-label="dismiss">
            ×
          </button>
        </div>
      )}

      {/* 评论列表 */}
      {commentsLoading ? (
        <div className="comment-section__loading">
          <Loader2 size={14} className="is-spinning" />
          <span>{t('share.comment.loading', { defaultValue: 'Loading comments...' })}</span>
        </div>
      ) : comments.length === 0 ? (
        <div className="comment-section__empty">
          {t('share.comment.empty', { defaultValue: 'No comments yet. Be the first to comment!' })}
        </div>
      ) : (
        <ul className="comment-section__list">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              currentMemberId={currentMemberId}
              commentSubmitting={commentSubmitting}
              editingId={editingId}
              replyToId={replyTo?.id ?? null}
              replyingToName={replyTo?.name ?? ''}
              editContent={editContent}
              replyContent={replyContent}
              editTooLong={editTooLong}
              replyTooLong={replyTooLong}
              editFormError={
                inputError?.field === 'edit' && editingId === comment.id ? inputError.message : null
              }
              replyFormError={
                inputError?.field === 'reply' && replyTo?.id === comment.id
                  ? inputError.message
                  : null
              }
              onEditContentChange={setEditContent}
              onReplyContentChange={setReplyContent}
              onStartEdit={startEdit}
              onStartReply={startReply}
              onCancelEdit={cancelEdit}
              onCancelReply={cancelReply}
              onEdit={handleEdit}
              onReply={handleReply}
              onDelete={handleDelete}
              t={t}
            />
          ))}
        </ul>
      )}

      {/* 加载更多按钮：当已加载数 < 总数时显示 */}
      {comments.length > 0 && comments.length < commentsTotal && (
        <div className="comment-section__load-more">
          <Button
            variant="ghost"
            size="small"
            onClick={() => loadMoreComments(shareId)}
            disabled={commentsLoading}
          >
            {commentsLoading
              ? t('share.comment.loading', { defaultValue: 'Loading...' })
              : t('share.comment.loadMore', { defaultValue: 'Load more' })}
          </Button>
          <span className="comment-section__count-info">
            {comments.length} / {commentsTotal}
          </span>
        </div>
      )}
    </div>
  );
};

export default CommentSection;

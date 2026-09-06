/**
 * PostCard — 帖子卡（feed/主页墙共用；详情页 rich 模式渲染完整 MD）
 *
 * 结构：作者行（头像/昵称/@username/可见性 Tag/相对时间/本人菜单）→
 * 正文（默认 stripMd 纯文本摘要；rich 时 Markdown 渲染 + stripImages）→ MediaGrid → 互动行。
 * 点赞 accent 心形（禁红）；删帖 confirmDanger；编辑 Modal 用 CommunityMDEditor。
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  Avatar,
  Button,
  confirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Markdown,
  Modal,
  Tag,
  toastError,
  toastSuccess,
} from '@/component-library';
import { Heart, MessageCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { communityApi, type CommunityPost } from './communityApi';
import { useCommunityStore } from './communityStore';
import { formatRelTime } from './time';
import { mdToPlain } from './md';
import { CommunityMDEditor } from './CommunityMDEditor';
import { MediaGrid } from './MediaGrid';

export const PostCard: React.FC<{ post: CommunityPost; rich?: boolean }> = ({ post, rich = false }) => {
  const { t } = useI18n();
  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const toggleLike = useCommunityStore((s) => s.toggleLike);
  const openDetail = useCommunityStore((s) => s.openDetail);
  const openProfile = useCommunityStore((s) => s.openProfile);
  const deletePost = useCommunityStore((s) => s.deletePost);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);

  const isMine = post.member_id === myMemberId;
  const displayName = post.nickname || post.username;

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: t('community.deletePostTitle', { defaultValue: '删除动态' }),
      message: t('community.deletePostMessage', { defaultValue: '删除后不可恢复，确定删除这条动态吗？' }),
      confirmDanger: true,
    });
    if (ok) void deletePost(post.id);
  };

  const onEditSave = async () => {
    const content = editText.trim();
    if (!content) return;
    setSaving(true);
    try {
      await communityApi.editPost(post.id, content);
      useCommunityStore.getState().updatePostContent(post.id, content);
      setEditing(false);
      toastSuccess(t('community.postEdited', { defaultValue: '动态已更新' }));
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="community-post">
      <header className="community-post__head">
        <button
          type="button"
          className="community-post__author"
          onClick={() => openProfile(post.member_id)}
        >
          <Avatar name={displayName} size="base" src={post.avatar || undefined} />
          <span className="community-post__author-meta">
            <span className="community-post__name">{displayName}</span>
            <span className="community-post__sub ds-data">
              @{post.username} · {formatRelTime(post.created_at)}
            </span>
          </span>
        </button>
        <span className="community-post__head-extra">
          {post.visibility === 'followers' && (
            <Tag color="gray" size="small">
              {t('community.visibilityFollowers', { defaultValue: '关注者' })}
            </Tag>
          )}
          {post.visibility === 'private' && (
            <Tag color="gray" size="small">
              {t('community.visibilityPrivate', { defaultValue: '仅自己' })}
            </Tag>
          )}
          {isMine && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="ghost"
                  size="xs"
                  shape="square"
                  tooltip={t('community.postMenu', { defaultValue: '更多操作' })}
                  aria-label={t('community.postMenu', { defaultValue: '更多操作' })}
                >
                  <MoreHorizontal size={16} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setEditText(post.content);
                    setEditing(true);
                  }}
                >
                  <Pencil size={14} aria-hidden />
                  {t('community.editPost', { defaultValue: '编辑' })}
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => void onDelete()}>
                  <Trash2 size={14} aria-hidden />
                  {t('community.deletePost', { defaultValue: '删除' })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </header>

      {post.content && (
        rich ? (
          <Markdown className="community-post__md" content={post.content} stripImages />
        ) : (
          <p className="community-post__content">{mdToPlain(post.content)}</p>
        )
      )}
      <MediaGrid media={post.media} />

      <footer className="community-post__actions">
        <button
          type="button"
          className={`community-post__action ${post.liked_by_me ? 'is-liked' : ''}`}
          onClick={() => void toggleLike(post)}
          aria-pressed={post.liked_by_me}
          aria-label={t('community.like', { defaultValue: '点赞' })}
        >
          <Heart size={16} strokeWidth={1.8} fill={post.liked_by_me ? 'currentColor' : 'none'} />
          <span className="ds-data">{post.like_count > 0 ? post.like_count : ''}</span>
        </button>
        <button
          type="button"
          className="community-post__action"
          onClick={() => openDetail(post)}
          aria-label={t('community.comment', { defaultValue: '评论' })}
        >
          <MessageCircle size={16} strokeWidth={1.8} />
          <span className="ds-data">{post.comment_count > 0 ? post.comment_count : ''}</span>
        </button>
      </footer>

      <Modal
        isOpen={editing}
        onClose={() => setEditing(false)}
        title={t('community.editPostTitle', { defaultValue: '编辑动态' })}
        size="medium"
      >
        <CommunityMDEditor value={editText} onChange={setEditText} disabled={saving} />
        <div className="community-composer__actions">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('common.cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            variant="primary"
            isLoading={saving}
            disabled={!editText.trim()}
            onClick={() => void onEditSave()}
          >
            {t('common.save', { defaultValue: '保存' })}
          </Button>
        </div>
      </Modal>
    </article>
  );
};

/**
 * PostCard — 帖子卡（feed/主页墙共用；详情页 rich 模式渲染完整 MD）
 *
 * 结构：作者行（头像/昵称/@username/可见性 Tag/相对时间/本人菜单）→
 * 正文（默认 stripMd 纯文本摘要；rich 时 Markdown 渲染 + stripImages）→ MediaGrid → 互动行。
 * 点赞 accent 心形（禁红）；删帖 confirmDanger；编辑 Modal 用 CommunityMDEditor。
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { MemberAvatar } from '../components/MemberAvatar';
import {
  Button,
  confirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Markdown,
  Modal,
  Select,
  Tag,
  Textarea,
  toastError,
  toastSuccess,
} from '@/component-library';
import {
  Bookmark,
  Flag,
  Heart,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Repeat2,
  Trash2,
} from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { communityApi, resolveMediaUrl, type CommunityPost } from './communityApi';
import { useCommunityStore } from './communityStore';
import { formatRelTime } from './time';
import { mdToPlain } from './md';
import { linkifyMentions, parseMentionHref, resolveMentionId } from './mention';
import { CommunityMDEditor } from './CommunityMDEditor';
import { MediaGrid } from './MediaGrid';

/** 博客卡封面（相对 URL 解析；缺省不渲染） */
const PostCover: React.FC<{ url: string }> = ({ url }) => {
  const [src, setSrc] = useState('');
  React.useEffect(() => {
    let alive = true;
    void resolveMediaUrl(url)
      .then((u) => {
        if (alive) setSrc(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  if (!src) return null;
  return <img className="community-post__cover" src={src} alt="" loading="lazy" draggable={false} />;
};

export const PostCard: React.FC<{ post: CommunityPost; rich?: boolean }> = ({ post, rich = false }) => {
  const { t } = useI18n('community');
  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const toggleLike = useCommunityStore((s) => s.toggleLike);
  const toggleBookmark = useCommunityStore((s) => s.toggleBookmark);
  const openDetail = useCommunityStore((s) => s.openDetail);
  const openProfile = useCommunityStore((s) => s.openProfile);
  const deletePost = useCommunityStore((s) => s.deletePost);
  const togglePin = useCommunityStore((s) => s.togglePin);
  const setFeedTag = useCommunityStore((s) => s.setFeedTag);
  const repostPost = useCommunityStore((s) => s.repostPost);
  const reportPost = useCommunityStore((s) => s.reportPost);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  // 举报（P3）
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportDetail, setReportDetail] = useState('');
  const [reporting, setReporting] = useState(false);

  const isMine = post.member_id === myMemberId;
  const displayName = post.nickname || post.username;

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: t('deletePostTitle', { defaultValue: '删除动态' }),
      message: t('deletePostMessage', { defaultValue: '删除后不可恢复，确定删除这条动态吗？' }),
      confirmDanger: true,
    });
    if (ok) void deletePost(post.id);
  };

  const onRepost = async () => {
    const ok = await confirmDialog({
      title: t('repostTitle', { defaultValue: '转发到我的动态？' }),
      message: t('repostMessage', { defaultValue: '将这条动态转发到你的主页，关注你的人可以在动态流中看到它。' }),
    });
    if (!ok) return;
    const done = await repostPost(post);
    if (done) toastSuccess(t('repostDone', { defaultValue: '已转发到我的动态' }));
  };

  const onReportSubmit = async () => {
    if (!reportReason) return;
    setReporting(true);
    try {
      const ok = await reportPost(post.id, reportReason, reportDetail.trim());
      if (ok) {
        setReportOpen(false);
        setReportReason('');
        setReportDetail('');
        toastSuccess(t('reportSubmitted', { defaultValue: '举报已提交，感谢反馈' }));
      }
    } finally {
      setReporting(false);
    }
  };

  const onEditSave = async () => {
    const content = editText.trim();
    if (!content) return;
    setSaving(true);
    try {
      await communityApi.editPost(post.id, content);
      useCommunityStore.getState().updatePostContent(post.id, content);
      setEditing(false);
      toastSuccess(t('postEdited', { defaultValue: '动态已更新' }));
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
          <MemberAvatar name={displayName} size="base" data={post.avatar} />
          <span className="community-post__author-meta">
            <span className="community-post__name">{displayName}</span>
            <span className="community-post__sub ds-data">
              @{post.username} · {formatRelTime(post.created_at)}
              {/* 浏览量（P3；仅详情页展示，feed 不渲染以减少噪音） */}
              {rich && (post.view_count ?? 0) > 0 && (
                <>
                  {' · '}
                  {t('views', { defaultValue: '{{n}} 次浏览', n: post.view_count ?? 0 })}
                </>
              )}
            </span>
          </span>
        </button>
        <span className="community-post__head-extra">
          {post.visibility === 'followers' && (
            <Tag color="gray" size="small">
              {t('visibilityFollowers', { defaultValue: '关注者' })}
            </Tag>
          )}
          {post.visibility === 'private' && (
            <Tag color="gray" size="small">
              {t('visibilityPrivate', { defaultValue: '仅自己' })}
            </Tag>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="ghost"
                size="xs"
                shape="square"
                tooltip={t('postMenu', { defaultValue: '更多操作' })}
                aria-label={t('postMenu', { defaultValue: '更多操作' })}
              >
                <MoreHorizontal size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isMine ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => {
                      setEditText(post.content);
                      setEditing(true);
                    }}
                  >
                    <Pencil size={14} aria-hidden />
                    {t('editPost', { defaultValue: '编辑' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void togglePin(post)}>
                    <Pin size={14} aria-hidden />
                    {post.pinned_at
                      ? t('unpin', { defaultValue: '取消置顶' })
                      : t('pin', { defaultValue: '置顶' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem destructive onSelect={() => void onDelete()}>
                    <Trash2 size={14} aria-hidden />
                    {t('deletePost', { defaultValue: '删除' })}
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem
                  onSelect={() => {
                    setReportReason('');
                    setReportDetail('');
                    setReportOpen(true);
                  }}
                >
                  <Flag size={14} aria-hidden />
                  {t('reportAction', { defaultValue: '举报' })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </header>

      {post.pinned_at && (
        <span className="community-post__pinflag ds-data">
          <Pin size={11} aria-hidden /> {t('pinned', { defaultValue: '置顶' })}
        </span>
      )}
      {rich && post.title && <h2 className="community-post__title">{post.title}</h2>}
      {post.tags && post.tags.length > 0 && (
        <div className="community-post__tags">
          {post.tags.map((tg) => (
            <button
              key={tg}
              type="button"
              className="community-post__tag"
              onClick={() => setFeedTag(tg)}
            >
              #{tg}
            </button>
          ))}
        </div>
      )}
      {post.content && (
        rich ? (
          // @提及 渲染为 #mention 链接；点击捕获 → 解析 username → 打开对方主页
          <div
            className="community-mention-linkify"
            onClickCapture={(e) => {
              const el = (e.target as HTMLElement).closest('a[href^="#mention/"]');
              if (!el) return;
              e.preventDefault();
              e.stopPropagation();
              const name = parseMentionHref(el.getAttribute('href') ?? '');
              if (!name) return;
              void resolveMentionId(name).then((id) => {
                if (id != null) openProfile(id);
              });
            }}
          >
            <Markdown className="community-post__md" content={linkifyMentions(post.content)} stripImages />
          </div>
        ) : (
          <p className="community-post__content">{mdToPlain(post.content)}</p>
        )
      )}
      {post.cover_url && <PostCover url={post.cover_url} />}
      <MediaGrid media={post.media} />

      {/* 转发嵌套卡（P3；源帖已删/不可见时显示占位） */}
      {post.repost_of != null && (
        post.repost_source ? (
          <button
            type="button"
            className="community-post__repost"
            onClick={() => openDetail(post.repost_source!)}
            aria-label={t('repostViewSource', { defaultValue: '查看源动态' })}
          >
            <span className="community-post__repost-head">
              <MemberAvatar
                name={post.repost_source.nickname || post.repost_source.username}
                size="sm"
                data={post.repost_source.avatar}
              />
              <span className="community-post__name">
                {post.repost_source.nickname || post.repost_source.username}
              </span>
              <span className="ds-data">@{post.repost_source.username}</span>
            </span>
            {post.repost_source.title && (
              <span className="community-post__repost-title">{post.repost_source.title}</span>
            )}
            {post.repost_source.content && (
              <span className="community-post__repost-content">
                {mdToPlain(post.repost_source.content)}
              </span>
            )}
            {post.repost_source.cover_url && (
              <PostCover url={post.repost_source.cover_url} />
            )}
          </button>
        ) : (
          <div className="community-post__repost community-post__repost--gone ds-data">
            {t('repostSourceGone', { defaultValue: '源动态已删除或不可见' })}
          </div>
        )
      )}

      <footer className="community-post__actions">
        <button
          type="button"
          className={`community-post__action ${post.liked_by_me ? 'is-liked' : ''}`}
          onClick={() => void toggleLike(post)}
          aria-pressed={post.liked_by_me}
          aria-label={t('like', { defaultValue: '点赞' })}
        >
          <Heart size={16} strokeWidth={1.8} fill={post.liked_by_me ? 'currentColor' : 'none'} />
          <span className="ds-data">{post.like_count > 0 ? post.like_count : ''}</span>
        </button>
        <button
          type="button"
          className="community-post__action"
          onClick={() => openDetail(post)}
          aria-label={t('comment', { defaultValue: '评论' })}
        >
          <MessageCircle size={16} strokeWidth={1.8} />
          <span className="ds-data">{post.comment_count > 0 ? post.comment_count : ''}</span>
        </button>
        <button
          type="button"
          className="community-post__action"
          onClick={() => void onRepost()}
          aria-label={t('repostAction', { defaultValue: '转发' })}
        >
          <Repeat2 size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={`community-post__action ${post.bookmarked_by_me ? 'is-liked' : ''}`}
          onClick={() => void toggleBookmark(post)}
          aria-pressed={!!post.bookmarked_by_me}
          aria-label={t('bookmark', { defaultValue: '收藏' })}
        >
          <Bookmark
            size={16}
            strokeWidth={1.8}
            fill={post.bookmarked_by_me ? 'currentColor' : 'none'}
          />
        </button>
      </footer>

      <Modal
        isOpen={editing}
        onClose={() => setEditing(false)}
        title={t('editPostTitle', { defaultValue: '编辑动态' })}
        size="medium"
      >
        <CommunityMDEditor
          value={editText}
          onChange={setEditText}
          disabled={saving}
          onImagesPicked={(files) => {
            // 编辑态媒体 v1 仅文本：提示走 Composer（与后端 edit 仅 content 一致）
            toastError(t('editMediaUnsupported', { defaultValue: '编辑仅支持修改文字' }));
            void files;
          }}
        />
        <div className="community-composer__actions">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            variant="primary"
            isLoading={saving}
            disabled={!editText.trim()}
            onClick={() => void onEditSave()}
          >
            {t('common:save', { defaultValue: '保存' })}
          </Button>
        </div>
      </Modal>

      {/* 举报弹窗（P3 治理；原因必选 + 补充说明可选） */}
      <Modal
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        title={t('reportTitle', { defaultValue: '举报动态' })}
        size="small"
      >
        <div className="community-report">
          <label className="community-report__label">
            {t('reportReason', { defaultValue: '举报原因' })}
          </label>
          <Select
            value={reportReason}
            onChange={(v) => setReportReason(String(v ?? ''))}
            placeholder={t('reportReasonPlaceholder', { defaultValue: '请选择举报原因' })}
            options={[
              { value: 'spam', label: t('reportReasonSpam', { defaultValue: '垃圾广告' }) },
              { value: 'abuse', label: t('reportReasonAbuse', { defaultValue: '辱骂攻击' }) },
              { value: 'porn', label: t('reportReasonPorn', { defaultValue: '色情低俗' }) },
              { value: 'fraud', label: t('reportReasonFraud', { defaultValue: '欺诈信息' }) },
              { value: 'other', label: t('reportReasonOther', { defaultValue: '其他' }) },
            ]}
          />
          <label className="community-report__label">
            {t('reportDetail', { defaultValue: '补充说明' })}
          </label>
          <Textarea
            value={reportDetail}
            onChange={(e) => setReportDetail(e.target.value)}
            placeholder={t('reportDetailPlaceholder', { defaultValue: '补充细节，帮助管理员更快处理（可选）' })}
            rows={4}
            maxLength={500}
          />
        </div>
        <div className="community-composer__actions">
          <Button variant="ghost" onClick={() => setReportOpen(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            variant="primary"
            isLoading={reporting}
            disabled={!reportReason}
            onClick={() => void onReportSubmit()}
          >
            {t('reportSubmit', { defaultValue: '提交举报' })}
          </Button>
        </div>
      </Modal>
    </article>
  );
};

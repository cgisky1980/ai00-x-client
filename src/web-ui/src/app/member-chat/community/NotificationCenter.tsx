/**
 * NotificationCenter — 社区通知中心
 *
 * 顶部返回 + 全部已读；列表行 = 触发者头像 + 行为文案（like/comment/reply/follow）
 * + 帖子摘要 + 相对时间，未读黛青点。点击：follow → 对方主页；
 * 其余 → 打开对应帖子详情。WS 到达时 memberChatStore 已做红点与列表刷新。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton } from '@/component-library';
import { MemberAvatar } from '../components/MemberAvatar';
import { ArrowLeft, AtSign, CheckCheck, Heart, MessageCircle, UserPlus, CornerUpLeft } from 'lucide-react';
import { useCommunityStore } from './communityStore';
import type { CommunityNotification } from './communityApi';
import { formatRelTime } from './time';

function NoticeIcon({ kind }: { kind: CommunityNotification['kind'] }) {
  const size = 12;
  if (kind === 'like') return <Heart size={size} aria-hidden />;
  if (kind === 'comment') return <MessageCircle size={size} aria-hidden />;
  if (kind === 'reply') return <CornerUpLeft size={size} aria-hidden />;
  if (kind === 'mention') return <AtSign size={size} aria-hidden />;
  return <UserPlus size={size} aria-hidden />;
}

export const NotificationCenter: React.FC = () => {
  const { t } = useI18n('community');
  const notifications = useCommunityStore((s) => s.notifications);
  const unreadNotices = useCommunityStore((s) => s.unreadNotices);
  const back = useCommunityStore((s) => s.back);
  const markAllRead = useCommunityStore((s) => s.markAllRead);
  const openProfile = useCommunityStore((s) => s.openProfile);
  const openPostById = useCommunityStore((s) => s.openPostById);

  const label = (n: CommunityNotification): string => {
    const name = n.actor_nickname || n.actor_name;
    if (n.kind === 'like') return t('noticeLike', { defaultValue: '{{name}} 赞了你的动态', name });
    if (n.kind === 'comment') return t('noticeComment', { defaultValue: '{{name}} 留言了你的动态', name });
    if (n.kind === 'reply') return t('noticeReply', { defaultValue: '{{name}} 回复了你', name });
    if (n.kind === 'mention') return t('noticeMention', { defaultValue: '{{name}} 提到了你', name });
    return t('noticeFollow', { defaultValue: '{{name}} 关注了你', name });
  };

  const onPick = (n: CommunityNotification) => {
    if (n.kind === 'follow') {
      openProfile(n.actor_id);
      return;
    }
    if (n.post_id != null) void openPostById(n.post_id);
  };

  return (
    <div className="community-notice">
      <header className="community-notice__topbar">
        <IconButton
          variant="ghost"
          shape="square"
          tooltip={t('back', { defaultValue: '返回' })}
          aria-label={t('back', { defaultValue: '返回' })}
          onClick={back}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <span className="community-notice__title">
          {t('noticeTitle', { defaultValue: '通知' })}
        </span>
        {unreadNotices > 0 && (
          <Button variant="ghost" size="small" onClick={() => void markAllRead()}>
            <CheckCheck size={14} aria-hidden />
            {t('markAllRead', { defaultValue: '全部已读' })}
          </Button>
        )}
      </header>

      <div className="community-notice__list">
        {notifications.length === 0 && (
          <Empty
            title={t('noticeEmpty', { defaultValue: '暂无通知' })}
            description={t('noticeEmptyHint', { defaultValue: '有人赞你/留言/关注你时会出现在这里' })}
          />
        )}
        {notifications.map((n) => (
          <button key={n.id} type="button" className="community-notice__row" onClick={() => onPick(n)}>
            <span className="community-notice__avatar">
              <MemberAvatar name={n.actor_nickname || n.actor_name} size="sm" data={n.actor_avatar} />
              <span className="community-notice__kind" aria-hidden>
                <NoticeIcon kind={n.kind} />
              </span>
            </span>
            <span className="community-notice__body">
              <span className="community-notice__label">{label(n)}</span>
              {n.post_excerpt && (
                <span className="community-notice__excerpt">{n.post_excerpt}</span>
              )}
            </span>
            <span className="community-notice__time ds-data">{formatRelTime(n.created_at)}</span>
            {!n.read_at && <span className="community-notice__unread" aria-label={t('unread', { defaultValue: '未读' })} />}
          </button>
        ))}
      </div>
    </div>
  );
};

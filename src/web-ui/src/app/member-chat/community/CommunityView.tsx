/**
 * CommunityView — 社区（广场）视图容器（迁移 020）
 *
 * 只做视图状态机切换与进入副作用；各视图内容由子组件实现：
 * feed=FeedView（广场/关注流）/ postDetail=PostDetail（详情+评论）/
 * profile=ProfileView（个人主页）/ notifications=NotificationCenter（通知中心）。
 * 业务状态与动作全部在 communityStore，本组件不持有状态。
 */
import React, { useEffect } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useCommunityStore } from './communityStore';
import { useMemberChatStore } from '../store/memberChatStore';
import { FeedView } from './FeedView';
import { PostDetail } from './PostDetail';
import { ProfileView } from './ProfileView';
import { NotificationCenter } from './NotificationCenter';
import { SearchResults } from './SearchResults';
import { TagView } from './TagView';
import './community.scss';

/** 本会话已拉过广场首屏的账号：从其它 rail tab 切回不再重传整包
 * （头像以 base64 内联在出参里，重拉代价高）；账号切换后自动重拉 */
let feedLoadedFor: number | null | undefined;

export const CommunityView: React.FC = () => {
  const { t } = useI18n('community');
  const view = useCommunityStore((s) => s.view);
  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);

  // 进入广场：拉未读红点 + 首屏 feed（子组件挂载后各自续拉详情/主页/通知）
  // 刷新由 setFeedTab/setFeedTag/发帖负责，切 tab 回来不重复整包重拉。
  useEffect(() => {
    void useCommunityStore.getState().refreshUnread();
    if (feedLoadedFor !== myMemberId) {
      feedLoadedFor = myMemberId;
      void useCommunityStore.getState().loadFeed(true);
    }
  }, [myMemberId]);

  return (
    <main className="community" aria-label={t('memberChat:tabCommunity', { defaultValue: '广场' })}>
      {view === 'feed' && <FeedView />}
      {view === 'postDetail' && <PostDetail />}
      {view === 'profile' && <ProfileView />}
      {view === 'notifications' && <NotificationCenter />}
      {view === 'search' && <SearchResults />}
      {view === 'tag' && <TagView />}
    </main>
  );
};

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
import { FeedView } from './FeedView';
import { PostDetail } from './PostDetail';
import { ProfileView } from './ProfileView';
import { NotificationCenter } from './NotificationCenter';
import { SearchResults } from './SearchResults';
import './community.scss';

export const CommunityView: React.FC = () => {
  const { t } = useI18n('community');
  const view = useCommunityStore((s) => s.view);

  // 进入广场：拉未读红点 + 首屏 feed（子组件挂载后各自续拉详情/主页/通知）
  useEffect(() => {
    void useCommunityStore.getState().refreshUnread();
    void useCommunityStore.getState().loadFeed(true);
  }, []);

  return (
    <main className="community" aria-label={t('memberChat:tabCommunity', { defaultValue: '广场' })}>
      {view === 'feed' && <FeedView />}
      {view === 'postDetail' && <PostDetail />}
      {view === 'profile' && <ProfileView />}
      {view === 'notifications' && <NotificationCenter />}
      {view === 'search' && <SearchResults />}
    </main>
  );
};

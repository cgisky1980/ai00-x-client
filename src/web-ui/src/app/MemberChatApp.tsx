/**
 * MemberChatApp — 会员聊天窗口（桌面端独立 Tauri 窗口，免登陆）
 *
 * 薄壳：只负责布局组装与弹窗挂载，业务状态/动作全部在 memberChatStore。
 * 布局（QQ9 结构）：最左 rail 导航（头像/消息/联系人/频道/空间/设置），
 * 列表面板（会话/联系人/频道树），中=频道头+频道主页（容器）或
 * 置顶+消息流+输入区（房间/私聊），右=信息面板（公告+成员，可开关）。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Empty, toast, toastError, toastSuccess } from '@/component-library';
import { ConnectionBanner } from './member-chat/components/ConnectionBanner';
import { RailNav } from './member-chat/components/RailNav';
import { Sidebar } from './member-chat/components/Sidebar';
import { SettingsPage } from './member-chat/settings/SettingsPage';
import { ChatHeader } from './member-chat/components/ChatHeader';
import { PinBar } from './member-chat/components/PinBar';
import { MessageList } from './member-chat/components/MessageList';
import { Composer } from './member-chat/components/Composer';
import { MembersPanel } from './member-chat/components/MembersPanel';
import { ChannelHome } from './member-chat/components/ChannelHome';
import { StartDmModal } from './member-chat/modals/StartDmModal';
import {
  AddFriendModal,
  FriendRequestsModal,
} from './member-chat/FriendsPanel';
import {
  ChannelSettingsModal,
  CreateChannelModal,
  GroupsModal,
} from './member-chat/ChatModals';
import { findChannelIn, useMemberChatStore } from './member-chat/store/memberChatStore';
import { CommunityView } from './member-chat/community/CommunityView';
import { useCommunityStore } from './member-chat/community/communityStore';
import './MemberChatApp.scss';

const MemberChatApp: React.FC = () => {
  const { t } = useI18n();

  const session = useMemberChatStore((s) => s.session);
  const channels = useMemberChatStore((s) => s.channels);
  const dms = useMemberChatStore((s) => s.dms);
  const members = useMemberChatStore((s) => s.members);
  const friendReqs = useMemberChatStore((s) => s.friendReqs);
  const friends = useMemberChatStore((s) => s.friends);
  const currentId = useMemberChatStore((s) => s.currentId);
  const unread = useMemberChatStore((s) => s.unread);
  const connection = useMemberChatStore((s) => s.connection);
  const myProfile = useMemberChatStore((s) => s.myProfile);
  const error = useMemberChatStore((s) => s.error);
  const notice = useMemberChatStore((s) => s.notice);
  const initSession = useMemberChatStore((s) => s.initSession);
  const clearError = useMemberChatStore((s) => s.clearError);
  const clearNotice = useMemberChatStore((s) => s.clearNotice);
  const communityUnread = useCommunityStore((s) => s.unreadNotices);

  // 弹窗（纯 UI 状态）
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showFriendReqs, setShowFriendReqs] = useState(false);
  const [showStartDm, setShowStartDm] = useState(false);

  // QQ9 布局状态：rail 功能页签（store 内，供社区跨视图跳转）+ 右侧信息面板开关
  const railTab = useMemberChatStore((s) => s.railTab);
  const setRailTab = useMemberChatStore((s) => s.setRailTab);
  const [infoOpen, setInfoOpen] = useState(true);

  // 免登陆：读取桌面端已有会话（store 内部加载频道/好友并建立 WS）
  useEffect(() => {
    void initSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 通知统一走 DS toast
  useEffect(() => {
    if (notice) {
      toastSuccess(notice);
      clearNotice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);
  useEffect(() => {
    if (error) {
      toastError(error);
      clearError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  // 未登录（桌面端无会话）→ 引导去主窗口登录
  if (session && !session.hasToken) {
    return (
      <div className="member-chat member-chat--no-auth">
        <div className="member-chat__no-auth-card">
          <h2>{t('memberChat.title', { defaultValue: '会员聊天' })}</h2>
          <p>
            {t('memberChat.notLoggedIn', {
              defaultValue: '尚未登录。请先在 Ai00-X 主窗口登录会员账号后再打开聊天。',
            })}
          </p>
        </div>
      </div>
    );
  }

  const current = findChannelIn(channels, dms, currentId);
  const isSuperAdmin = !!session?.isSuperAdmin;
  // 顶层官方频道 = 分类容器（迁移 018）：不可发言，显示频道主页（简介/通告/房间跳转）
  const isContainer =
    !!current && !current.is_dm && current.kind === 'official' && current.parent_id == null;

  // rail 角标：消息态 = DM + 房间未读合计；联系人态 = 好友申请数
  const unreadChats =
    dms.reduce((n, d) => n + (unread[d.channel_id] || 0), 0) +
    channels
      .filter((c) => c.parent_id != null)
      .reduce((n, c) => n + (unread[c.id] || 0), 0);

  return (
    <div className="member-chat">
      <ConnectionBanner />

      <div className="member-chat__body">
        <RailNav
          tab={railTab}
          onTabChange={setRailTab}
          unreadChats={unreadChats}
          friendReqCount={friendReqs.length}
          communityUnread={communityUnread}
          connection={connection}
          username={session?.username || '?'}
          avatarData={myProfile?.avatarData}
        />

        {/* 个人设置 / 社区广场：整页替换聊天区 */}
        {railTab === 'settings' ? (
          <SettingsPage />
        ) : railTab === 'community' ? (
          <CommunityView />
        ) : (
          <>
            <Sidebar
              tab={railTab}
              onOpenFriendRequests={() => setShowFriendReqs(true)}
              onOpenCreateChannel={() => setShowCreate(true)}
              onOpenStartDm={() => setShowStartDm(true)}
              onOpenAddFriend={() => setShowAddFriend(true)}
            />

            <main className="member-chat__main">
              {current ? (
                <>
                  <ChatHeader
                    onOpenSettings={() => setShowSettings(true)}
                    onOpenGroups={() => setShowGroups(true)}
                    infoOpen={infoOpen}
                    onToggleInfo={() => setInfoOpen((v) => !v)}
                  />
                  {isContainer ? (
                    <ChannelHome channel={current} />
                  ) : (
                    <>
                      <PinBar />
                      <MessageList />
                      <Composer />
                    </>
                  )}
                </>
              ) : (
                <div className="member-chat__main-empty">
                  <Empty
                    title={t('memberChat.selectChannel', { defaultValue: '选择一个会话开始聊天' })}
                    description={t('memberChat.selectChannelHint', {
                      defaultValue: '从左侧选择私聊或频道',
                    })}
                  />
                </div>
              )}
            </main>

            {infoOpen && <MembersPanel />}
          </>
        )}
      </div>

      {showStartDm && (
        <StartDmModal friends={friends} onClose={() => setShowStartDm(false)} />
      )}
      {showCreate && isSuperAdmin && (
        <CreateChannelModal
          channels={channels}
          isSuperAdmin
          onClose={() => setShowCreate(false)}
          onCreated={() => void useMemberChatStore.getState().refreshChannels()}
        />
      )}
      {showSettings && current && (
        <ChannelSettingsModal
          channel={current}
          onClose={() => setShowSettings(false)}
          onSaved={() => void useMemberChatStore.getState().refreshChannels()}
        />
      )}
      {showGroups && current && (
        <GroupsModal
          channel={current}
          members={members}
          onClose={() => setShowGroups(false)}
          onChanged={() =>
            void useMemberChatStore.getState().selectChannel(current.id)
          }
        />
      )}
      {showAddFriend && (
        <AddFriendModal
          onClose={() => setShowAddFriend(false)}
          onNotice={(msg) => {
            toast(msg);
            void useMemberChatStore.getState().refreshFriends();
          }}
        />
      )}
      {showFriendReqs && (
        <FriendRequestsModal
          requests={friendReqs}
          onClose={() => setShowFriendReqs(false)}
          onRespond={(id, accept) =>
            useMemberChatStore.getState().respondFriendReq(id, accept)
          }
        />
      )}
    </div>
  );
};

export default MemberChatApp;

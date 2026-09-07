/**
 * CreditsScene — 积分中心场景。
 *
 * 内含三个页面（Tabs 切换）：
 * - 积分充值（RechargeView）：手游九宫格风格档位卡片
 * - 会员套餐（MembershipView）：套餐对比 + 每日签到
 * - 邀请有礼（InviteView）：领取制邀请码 + 分红 + 会员打折券
 */

import React, { useEffect, useState } from 'react';
import { Tabs, TabPane } from '@/component-library';
import { getMemberProfile } from '@/infrastructure/account/api';
import UsageView from './UsageView';
import RechargeView from './RechargeView';
import MembershipView from './MembershipView';
import InviteView from './InviteView';
import { onCreditsTabRequest, type CreditsTabKey } from './creditsSceneEvents';
import './CreditsScene.scss';

const CreditsScene: React.FC = () => {
  const [activeKey, setActiveKey] = useState<CreditsTabKey>('usage');
  /** 被邀请注册的用户展示新人权益卡片（invite_by 非空；接口失败静默跳过） */
  const [isNewcomer, setIsNewcomer] = useState(false);

  // 响应外部入口的页签定位请求（如账户设置页的"会员套餐"按钮）
  useEffect(() => onCreditsTabRequest(setActiveKey), []);

  useEffect(() => {
    let cancelled = false;
    getMemberProfile()
      .then(profile => {
        if (!cancelled && profile.member.invite_by != null) setIsNewcomer(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="ai00-x-credits-scene">
      <div className="ai00-x-credits-scene__inner">
        <header className="ai00-x-credits-scene__header">
          <div className="ai00-x-credits-scene__heading">
            <h1 className="ai00-x-credits-scene__title">积分中心</h1>
            <p className="ai00-x-credits-scene__subtitle">消耗与充值，积分一目了然</p>
          </div>
          <Tabs
            type="pill"
            className="ai00-x-credits-scene__tabs"
            activeKey={activeKey}
            onChange={key => setActiveKey(key as CreditsTabKey)}
          >
            <TabPane tabKey="usage" label="积分消耗" />
            <TabPane tabKey="recharge" label="积分充值" />
            <TabPane tabKey="membership" label="会员套餐" />
            <TabPane tabKey="invite" label="邀请有礼" />
          </Tabs>
        </header>
        {isNewcomer && (
          <section className="ai00-x-credits-scene__newcomer" aria-label="新人权益">
            <span className="ai00-x-credits-scene__newcomer-badge">邀请制专属</span>
            <span className="ai00-x-credits-scene__newcomer-text">新人铭牌 + 新功能优先体验，已在你的账户生效</span>
          </section>
        )}
        {activeKey === 'usage' && <UsageView />}
        {activeKey === 'recharge' && <RechargeView />}
        {activeKey === 'membership' && <MembershipView />}
        {activeKey === 'invite' && <InviteView />}
      </div>
    </div>
  );
};

export default CreditsScene;

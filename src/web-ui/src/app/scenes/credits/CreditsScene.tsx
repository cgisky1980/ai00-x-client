/**
 * CreditsScene — 积分中心场景。
 *
 * 内含两个页面（Tabs 切换）：
 * - 积分充值（RechargeView）：手游九宫格风格档位卡片
 * - 会员套餐（MembershipView）：五档对比 + 每日签到
 */

import React, { useEffect, useState } from 'react';
import { Tabs, TabPane } from '@/component-library';
import RechargeView from './RechargeView';
import MembershipView from './MembershipView';
import { onCreditsTabRequest, type CreditsTabKey } from './creditsSceneEvents';
import './CreditsScene.scss';

const CreditsScene: React.FC = () => {
  const [activeKey, setActiveKey] = useState<CreditsTabKey>('recharge');

  // 响应外部入口的页签定位请求（如账户设置页的"会员套餐"按钮）
  useEffect(() => onCreditsTabRequest(setActiveKey), []);

  return (
    <div className="ai00-x-credits-scene">
      <div className="ai00-x-credits-scene__inner">
        <header className="ai00-x-credits-scene__header">
          <h1 className="ai00-x-credits-scene__title">积分中心</h1>
          <p className="ai00-x-credits-scene__subtitle">充值与会员，积分一目了然</p>
        </header>
        <Tabs
          type="pill"
          activeKey={activeKey}
          onChange={key => setActiveKey(key as CreditsTabKey)}
        >
          <TabPane tabKey="recharge" label="积分充值">
            <RechargeView />
          </TabPane>
          <TabPane tabKey="membership" label="会员套餐">
            <MembershipView />
          </TabPane>
        </Tabs>
      </div>
    </div>
  );
};

export default CreditsScene;

/**
 * CreditsBadge — 策窗口标题栏积分徽标。
 *
 * 显示当前积分余额（creditsStore.loadSummary，webview 内独立实例自行拉取），
 * 点击打开积分中心（credits 场景，默认充值页签）。
 *
 * 降级：接口失败（服务端旧版 / 未登录）时徽标整体隐藏，保持标题栏干净。
 */

import React, { useEffect } from 'react';
import { Coins } from 'lucide-react';
import { useCreditsStore } from '../../../app/scenes/credits/creditsStore';
import { useTodoStore } from '../store/todoStore';
import { requestCreditsTab } from '../../../app/scenes/credits/creditsSceneEvents';

export const CreditsBadge: React.FC = () => {
  const summary = useCreditsStore((s) => s.summary);
  const loadingSummary = useCreditsStore((s) => s.loadingSummary);
  const loadSummary = useCreditsStore((s) => s.loadSummary);

  useEffect(() => {
    void loadSummary().catch(() => {});
  }, [loadSummary]);

  // 接口失败（summary 拉不到且非加载中）→ 隐藏徽标
  if (!loadingSummary && !summary) return null;

  return (
    <button
      type="button"
      className="todo-panel__credits"
      onClick={(e) => {
        e.stopPropagation();
        requestCreditsTab('recharge');
        // 策窗口浮层收起，露出主窗口刚打开的积分中心页签
        useTodoStore.getState().togglePanel(false);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title="积分与会员"
    >
      <Coins size={13} />
      <span className="todo-panel__credits-value ds-data">
        {loadingSummary ? '…' : summary?.total ?? 0}
      </span>
    </button>
  );
};

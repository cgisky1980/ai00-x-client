/**
 * SettingsWindowApp — 「设置」独立窗口根组件（窗口 label = settings）。
 *
 * 2026-11-08：原「策」窗口（label = tasks）回退为设置窗口——任务看板、计划
 * 面板、规划讨论等 UI 从该窗口撤下，只保留系统设置（`SettingsView`）。
 * 策的常驻运行时（overlay 里的 `TodoOverlay`：提醒 ticker / agent 看门狗 /
 * DSH mux）仍在 overlay 窗口，不随本窗口开关启停，老任务照旧运行。
 */
import React from 'react';
import { SettingsView } from '../tools/todo/components/views/SettingsView';
import { NotificationContainer } from '../shared/notification-system';
import './SettingsWindowApp.scss';

const SettingsWindowApp: React.FC = () => (
  <div className="ai00-x-settings-window">
    <SettingsView />
    {/* 设置页里大量「保存成功 / 保存失败」走 notificationService；容器只挂在
        主窗口时这些提示在本窗口是静默的（与工作台清理提示同一类问题）。
        bootstrap 的 toast:false 只管提醒类 toast，不会造成重复。 */}
    <NotificationContainer />
  </div>
);

export default SettingsWindowApp;

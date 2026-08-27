/**
 * AgentModePicker — 卡片创建时的执行方式选择（想法卡/恒共用）。
 *
 * 语义（写入 task.agentModule）：
 * - 人做（undefined）：不使用 agent
 * - Auto（'agent'）：交付时委托通用 agent 执行
 *
 * 特化模块（代码/壁纸/音乐）后置为 agent 系统插件——插件时代在
 * AGENT_MODULES 注册后此处自动出现模块 chips（此处渲染注册表，无需改）。
 */
import React from 'react';
import { Sparkles, User } from 'lucide-react';
import { AGENT_MODULES } from '../agent-modules';

export type AgentModeValue = string | undefined; // undefined | 'agent' |（插件时代）moduleId

const AgentModePicker: React.FC<{
  value: AgentModeValue;
  onChange: (v: AgentModeValue) => void;
  /** 排除 openStudio 型模块（恒·定时任务不走工坊跳转） */
  excludeStudio?: boolean;
}> = ({ value, onChange, excludeStudio }) => {
  const modules = AGENT_MODULES.filter(m => m.id !== 'agent' && (!excludeStudio || !m.openStudio));
  return (
    <div className="td-chips">
      <span className="td-label">执行</span>
      <button
        type="button"
        className={`td-chip${value === undefined ? ' is-on' : ''}`}
        onClick={() => onChange(undefined)}
        title="自己动手，不使用 agent"
      >
        <User size={10} style={{ display: 'inline', verticalAlign: '-1px' }} /> 人做
      </button>
      <button
        type="button"
        className={`td-chip${value === 'agent' || value === 'auto' ? ' is-on' : ''}`}
        onClick={() => onChange('agent')}
        title="交付时委托通用 agent 按计划契约执行"
      >
        <Sparkles size={10} style={{ display: 'inline', verticalAlign: '-1px' }} /> Auto
      </button>
      {modules.map(m => (
        <button
          key={m.id}
          type="button"
          className={`td-chip${value === m.id ? ' is-on' : ''}`}
          onClick={() => onChange(m.id)}
          title={m.description}
        >
          {m.title}
        </button>
      ))}
    </div>
  );
};

export default AgentModePicker;

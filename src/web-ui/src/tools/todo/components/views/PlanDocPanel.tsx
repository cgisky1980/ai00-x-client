/**
 * PlanDocPanel — 策下半区左半：选中卡片的计划文档（MD）。
 *
 * 渲染用 component-library 的 Markdown 组件；编辑切换源码文本域；
 * 读写走 todo_plan_get/set（plans/<taskId>.md，人与 agent 共享文件）。
 * 监听 `todo-plan-updated`（任何一方写入——含 agent 的 ai00_plan_write）
 * 热刷新展示；正在编辑时不打断，保存时以本地草稿为准。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check, Maximize2, Minimize2, Pencil, Send } from 'lucide-react';
import { Markdown } from '@/component-library';
import type { TodoTask } from '../../api/types';
import { useAgentDelegate } from '../../hooks/useAgentDelegate';
import { useTodoStore } from '../../store/todoStore';
import { parseAcceptance } from '../../utils/planAcceptance';

export const PlanDocPanel: React.FC<{
  task: TodoTask;
}> = ({ task }) => {
  const [md, setMd] = useState<string | null>(null); // null = 无计划文件
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [delegating, setDelegating] = useState(false);
  const { delegate } = useAgentDelegate();
  const setPlanAcceptance = useTodoStore((s) => s.setPlanAcceptance);
  // 全高/半高切换（全高=顶替进行中栏到底；半高=只占下半，进行中栏可见）
  const expanded = useTodoStore((s) => s.planDocExpanded);
  const toggleExpanded = useTodoStore((s) => s.togglePlanDocExpanded);
  const editingRef = useRef(false);
  editingRef.current = editing;

  // 验收段解析回填看板徽标缓存（唯一真源 = 计划 MD 勾选态）
  useEffect(() => {
    const items = parseAcceptance(md);
    setPlanAcceptance(task.id, items.filter(i => i.done).length, items.length);
  }, [task.id, md, setPlanAcceptance]);

  const reload = useCallback(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    invoke<string | null>('todo_plan_get', { taskId: task.id })
      .then(content => {
        if (cancelled) return;
        setMd(content);
        setDraft(content ?? '');
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const handleDelegate = async () => {
    setDelegating(true);
    await delegate(task);
    setDelegating(false);
  };

  // 选中卡片变化 → 重读计划文件（plan 变化=生成计划，也触发）
  useEffect(() => {
    setEditing(false);
    return reload();
  }, [task.id, task.plan, reload]);

  // agent 侧 ai00_plan_write → 宿主广播 → 热刷新（编辑态不打断）
  useEffect(() => {
    const un = listen<{ taskId: string }>('todo-plan-updated', e => {
      if (e.payload?.taskId === task.id && !editingRef.current) reload();
    });
    return () => {
      void un.then(f => f());
    };
  }, [task.id, reload]);

  const save = async () => {
    try {
      await invoke('todo_plan_set', { taskId: task.id, markdown: draft });
      setMd(draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="td-plandoc">
      <div className="td-plandoc__head">
        <span className="td-plandoc__title">计划 · {task.title}</span>
        {/* 交付执行：计划确认后委托 agent（已委托则显示会话态） */}
        {task.agentSessionId ? (
          <span className="td-chip" title={`已委托（会话 ${task.agentSessionId.slice(8, 20)}）`}>
            <Send size={11} /> 已交付
          </span>
        ) : (
          <button
            className="td-chip is-on"
            onClick={handleDelegate}
            disabled={delegating || loading}
            title="按此计划委托 agent 执行（打开 Agent 场景）"
          >
            <Send size={11} /> {delegating ? '交付中…' : '交付执行'}
          </button>
        )}
        {md !== null &&
          !loading &&
          (editing ? (
            <button className="td-chip is-on" onClick={save} title="保存计划文档">
              <Check size={11} /> 保存
            </button>
          ) : (
            <button className="td-chip" onClick={() => setEditing(true)} title="编辑计划源码">
              <Pencil size={11} /> 编辑
            </button>
          ))}
        <button
          className="td-chip"
          onClick={toggleExpanded}
          title={
            expanded
              ? '收窄：只占下半（进行中栏恢复显示）'
              : '放大：顶替进行中栏到底部（看完整计划）'
          }
        >
          {expanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
        </button>
      </div>
      <div className="td-plandoc__body">
        {loading && <div className="td-plandoc__empty">读取中…</div>}
        {!loading && error && <div className="td-plandoc__empty">{error}</div>}
        {!loading && !error && md === null && (
          <div className="td-plandoc__empty">尚无计划——在右侧和 AI 讨论需求，点「生成计划」</div>
        )}
        {!loading && !error && md !== null && editing && (
          <textarea
            className="td-plandoc__editor"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
          />
        )}
        {!loading && !error && md !== null && !editing && (
          <div className="td-plandoc__view">
            <Markdown content={md} />
          </div>
        )}
      </div>
    </div>
  );
};

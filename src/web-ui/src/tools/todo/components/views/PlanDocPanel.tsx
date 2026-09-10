/**
 * PlanDocPanel — 策下半区右列：计划窗（抽屉式）。
 *
 * 三个抽屉：① 步骤——执行到哪一步（✓ 完成 / ▶ 当前 / □ 未开始，默认展开）；
 * ② 验收——DoD 清单（可点击代勾，agent 提交自检后此处放「验收通过/打回」，
 * 未提交时是「标记完成」人工路径）；③ 原文——计划 MD 全文查看/编辑（默认折叠）。
 * 顶栏只留标题与交付状态，动作按钮各归各的抽屉，避免窄窗口挤成一条。
 *
 * 读写走 todo_plan_get/set（plans/<taskId>.md，人与 agent 共享文件）；
 * 监听 `todo-plan-updated`（任何一方写入——含 agent 的 ai00_plan_write）
 * 热刷新展示；正在编辑时不打断，保存时以本地草稿为准。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check, ChevronDown, ChevronRight, Diff, Pencil, RotateCcw, Send, Undo2 } from 'lucide-react';
import { Markdown, Modal } from '@/component-library';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { addMemory } from '@/infrastructure/api/aiMemoryApi';
import { aiComplete } from '../../ai/consult';
import { resolveDelegateCwd } from '../../ai/workspace';
import type { TodoTask } from '../../api/types';
import { XpKinds } from '../../api/types';
import { addXpEvent } from '../../api/XpApi';
import { useAgentDelegate } from '../../hooks/useAgentDelegate';
import { useTodoStore } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import {
  parseAcceptance,
  parseStepItems,
  parseSteps,
  toggleAcceptanceLine,
  type AcceptanceItem,
} from '../../utils/planAcceptance';

/** 单个抽屉（可折叠段落；header 右侧可挂动作按钮，点击不触发折叠）。 */
const Drawer: React.FC<{
  open: boolean;
  onToggle: () => void;
  label: string;
  summary?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ open, onToggle, label, summary, actions, children }) => (
  <div className="td-plandoc__drawer">
    <div className="td-plandoc__drawer-head" onClick={onToggle}>
      <span className="td-plandoc__drawer-caret">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </span>
      <span className="td-plandoc__drawer-label">{label}</span>
      {summary != null && summary !== '' && (
        <span className="td-plandoc__drawer-summary">{summary}</span>
      )}
      <span style={{ flex: 1 }} />
      {actions && (
        <span className="td-plandoc__drawer-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
    {open && <div className="td-plandoc__drawer-body">{children}</div>}
  </div>
);

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
  const setPlanSteps = useTodoStore((s) => s.setPlanSteps);
  const completeTask = useTodoStore((s) => s.completeTask);
  const updateTask = useTodoStore((s) => s.updateTask);
  const showToast = useGrowthStore((s) => s.showToast);
  const checkBadges = useGrowthStore((s) => s.checkBadges);
  const editingRef = useRef(false);
  editingRef.current = editing;

  // 抽屉开合：步骤默认展开；验收在「待人类验收」时自动展开；原文默认折叠
  const [openSteps, setOpenSteps] = useState(true);
  const [openAcc, setOpenAcc] = useState(false);
  const [openRaw, setOpenRaw] = useState(false);

  // 验收 diff/回滚（有基线+自检双快照时可用——人眼验收 agent 的实际改动）
  const hasSnapshots = Boolean(task.agentBaseCommit && task.agentCommit);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffText, setDiffText] = useState('');

  const showDiff = async (): Promise<void> => {
    const dir = resolveDelegateCwd(useTodoStore.getState().data, task.goalId);
    if (!dir || !hasSnapshots) return;
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      const text = await invoke<string>('git_get_diff', {
        request: {
          repository_path: dir,
          params: { source: task.agentBaseCommit as string, target: task.agentCommit as string },
        },
      });
      setDiffText(text?.trim() ? text : '（两份快照之间无差异）');
    } catch (e) {
      setDiffText(`获取 diff 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiffLoading(false);
    }
  };

  const handleRollback = async (): Promise<void> => {
    const dir = resolveDelegateCwd(useTodoStore.getState().data, task.goalId);
    if (!dir || !task.agentBaseCommit) return;
    if (
      !(await window.confirm(
        '回滚到 agent 动工前的工作区状态？agent 的全部改动将被丢弃（计划文档与讨论记录保留）。',
      ))
    )
      return;
    try {
      await invoke('git_reset_to_commit', {
        request: { repository_path: dir, commit_hash: task.agentBaseCommit, mode: 'hard' },
      });
      showToast('已回滚', '工作区已回到委托前状态');
    } catch (e) {
      showToast('回滚失败', e instanceof Error ? e.message : String(e));
    }
  };

  // 验收段解析（唯一真源 = 计划 MD 勾选态）：回填看板徽标缓存 + 「验收通过」门控
  const acceptanceItems = useMemo(() => parseAcceptance(md), [md]);
  const accDone = acceptanceItems.filter(i => i.done).length;
  const accTotal = acceptanceItems.length;
  useEffect(() => {
    setPlanAcceptance(task.id, accDone, accTotal);
  }, [task.id, accDone, accTotal, setPlanAcceptance]);

  // 步骤段解析：回填进度缓存（执行面板头部/看板卡 ▶n/5）+ 抽屉渲染
  const stepItems = useMemo(() => parseStepItems(md), [md]);
  const steps = useMemo(() => parseSteps(md), [md]);
  const currentStepIndex = useMemo(
    () => stepItems.findIndex(i => !i.done),
    [stepItems],
  );
  useEffect(() => {
    setPlanSteps(task.id, steps.done, steps.total, steps.current);
  }, [task.id, steps, setPlanSteps]);

  // agent 提交自检 → 自动展开验收抽屉（人该看这里了）
  const awaitingHuman = Boolean(task.agentCompletedAt) && !task.completedAt;
  const isDoing = (task.status ?? 'requirement') === 'doing';
  useEffect(() => {
    if (awaitingHuman) {
      setOpenAcc(true);
      setOpenSteps(false);
    }
  }, [awaitingHuman]);

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

  /** XP 公式（迁自原 ai00_task_complete）：10 基础 + 今日到期 5 + 检查项全勾 3（上限 20）。 */
  const xpFor = (t: TodoTask): number => {
    let xp = 10;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (t.due && t.due <= today) xp += 5;
    if (t.checklist.length > 0 && t.checklist.every((c) => c.d)) xp += 3;
    return Math.min(xp, 20);
  };

  /** 人类验收通过（双段验收第二段）：completedAt + XP；周期克隆在 completeTask 内。 */
  const distillMemory = async (): Promise<void> => {
    try {
      const chat = (task.chat ?? [])
        .slice(-6)
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.text.slice(0, 200)}`)
        .join('\n');
      const out = await aiComplete(
        `任务「${task.title}」已验收通过。\n${chat ? `打回历史与讨论：\n${chat}\n` : ''}如果这次任务有值得长期记住的经验（用户偏好/项目事实/避坑教训），只输出一条简洁经验（50 字内）；没有就只输出：无`,
        '你是记忆蒸馏器，只输出经验文本或「无」。',
        {
          temperature: 0.3,
          maxTokens: 120,
          model: task.discussModel && task.discussModel !== 'auto' ? task.discussModel : undefined,
          tag: `todo:memory:${task.id}`,
        },
      );
      const text = (out || '').trim();
      if (!text || /^无$/.test(text)) return;
      await addMemory({
        title: task.title.slice(0, 40),
        content: text.slice(0, 500),
        type: 'project_context',
        importance: 3,
        tags: ['策', '验收沉淀'],
      });
    } catch {
      // 蒸馏失败静默——不影响验收主流程
    }
  };

  const accept = () => {
    completeTask(task.id, true);
    const xp = xpFor(task);
    // 服务器按 taskId 幂等去重；未登录时静默跳过
    void addXpEvent(XpKinds.taskDone, xp, { taskId: task.id, title: task.title }).catch(() => undefined);
    void checkBadges();
    showToast('验收通过', `「${task.title.slice(0, 16)}」已成 +${xp}XP`);
    void distillMemory();
  };

  /** 验收后经验蒸馏（fire-and-forget）：讨论模型判断值得记则写入记忆库，
   *  下次委托时随任务书注入——形成"做过→记住→复用"闭环。失败静默。 */

  /** 打回：清模型自检态，理由发回会话（agent 重读计划，继续完善）。 */
  const handleReject = async () => {
    const input = await window.prompt('打回理由（将发给 agent，可留空）', '请继续完善：验收未通过');
    if (input == null) return;
    const reason = input.trim() || '请继续完善：验收未通过';
    updateTask(task.id, { agentCompletedAt: null });
    if (task.agentSessionId) {
      void dshSession
        .prompt(
          task.agentSessionId,
          `【验收打回】${reason}。请先用 ai00_plan_read 重读计划文档；若打回涉及需求/方案变化，先更新计划再继续执行。`,
        )
        .catch(() => undefined);
    }
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

  /** 人类代勾/取消验收项（与 agent 对等读写同一 MD；todo_plan_set 触发广播热刷新）。 */
  const accBusyRef = useRef(false);
  const toggleAcc = async (item: AcceptanceItem, next: boolean) => {
    if (md == null || accBusyRef.current) return;
    accBusyRef.current = true;
    try {
      const nextMd = toggleAcceptanceLine(md, item.lineIndex, next);
      await invoke('todo_plan_set', { taskId: task.id, markdown: nextMd });
      setMd(nextMd);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      accBusyRef.current = false;
    }
  };

  const canTickAcc = isDoing && !task.completedAt && !loading;

  return (
    <div className="td-plandoc">
      <div className="td-plandoc__head">
        <span className="td-plandoc__title">计划 · {task.title}</span>
        {/* 交付状态（任务级动作只留这一个在顶栏） */}
        {task.agentSessionId ? (
          <span className="td-chip" title={`已交付（会话 ${task.agentSessionId.slice(8, 20)}）`}>
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
        {awaitingHuman && (
          <span
            className="td-chip"
            title={`模型自检通过于 ${new Date(task.agentCompletedAt as number).toLocaleTimeString()}`}
          >
            已自检
          </span>
        )}
      </div>

      <div className="td-plandoc__drawers">
        {loading && <div className="td-plandoc__empty">读取中…</div>}
        {!loading && error && <div className="td-plandoc__empty">{error}</div>}
        {!loading && !error && md === null && (
          <div className="td-plandoc__empty">尚无计划——在左侧与 AI 讨论需求，计划拟定后自动出现在这里</div>
        )}
        {!loading && !error && md !== null && (
          <>
            {/* 抽屉 1：步骤——执行到哪一步 */}
            <Drawer
              open={openSteps}
              onToggle={() => setOpenSteps(v => !v)}
              label="步骤"
              summary={
                stepItems.length > 0
                  ? `${steps.done}/${steps.total}${steps.current && isDoing ? ` · ${steps.current}` : ''}`
                  : '无步骤'
              }
            >
              {stepItems.length === 0 ? (
                <div className="td-plandoc__empty">计划还没有步骤（旧格式或未生成）</div>
              ) : (
                stepItems.map((s, i) => (
                  <div
                    key={s.lineIndex}
                    className={`td-plandoc__step${s.done ? ' is-done' : i === currentStepIndex ? ' is-current' : ''}`}
                  >
                    <span className="td-plandoc__step-mark">{s.done ? '✓' : i === currentStepIndex ? '▶' : '·'}</span>
                    <span className="td-plandoc__step-text">{s.text}</span>
                  </div>
                ))
              )}
            </Drawer>

            {/* 抽屉 2：验收——要验哪些（可代勾）+ 验收动作 */}
            <Drawer
              open={openAcc}
              onToggle={() => setOpenAcc(v => !v)}
              label="验收"
              summary={accTotal > 0 ? `${accDone}/${accTotal}` : '无验收项'}
            >
              {accTotal === 0 ? (
                <div className="td-plandoc__empty">无验收项（免验收）</div>
              ) : (
                <>
                  {/* 验收动作条（抽屉体顶部右对齐——不放头部，避免窄窗口挤成一条） */}
                  {isDoing && !task.completedAt && (
                    <div className="td-plandoc__acc-actions">
                      {awaitingHuman && hasSnapshots && (
                        <button className="td-chip" onClick={() => void showDiff()} title="查看 agent 的实际改动（基线→自检 diff）">
                          <Diff size={11} /> 查看改动
                        </button>
                      )}
                      {awaitingHuman && (
                        <button className="td-chip" onClick={() => void handleRollback()} title="丢弃 agent 全部改动，工作区回到动工前状态">
                          <RotateCcw size={11} /> 回滚
                        </button>
                      )}
                      {awaitingHuman && (
                        <button className="td-chip" onClick={() => void handleReject()} title="打回：agent 重读计划继续完善">
                          <Undo2 size={11} /> 打回
                        </button>
                      )}
                      <button
                        className="td-chip is-on"
                        onClick={accept}
                        disabled={accTotal > 0 && accDone < accTotal}
                        title={
                          accTotal > 0 && accDone < accTotal
                            ? `还有 ${accTotal - accDone} 项验收未通过（可点击代勾）`
                            : '人类验收通过，标记完成'
                        }
                      >
                        <Check size={11} />
                        {awaitingHuman ? '验收通过' : '标记完成'}
                        {accTotal > 0 ? ` ${accDone}/${accTotal}` : ''}
                      </button>
                    </div>
                  )}
                  {acceptanceItems.map(a => (
                    <button
                      key={a.lineIndex}
                      className={`td-plandoc__acc${a.done ? ' is-done' : ''}`}
                      onClick={() => void toggleAcc(a, !a.done)}
                      disabled={!canTickAcc}
                      title={canTickAcc ? (a.done ? '点击取消勾选' : '点击确认通过') : '交付执行后可勾选'}
                    >
                      <span className="td-plandoc__accbox">{a.done ? '✓' : ''}</span>
                      <span className="td-plandoc__acctext">{a.text}</span>
                    </button>
                  ))}
                </>
              )}
            </Drawer>

            {/* 抽屉 3：原文——计划 MD 查看/编辑（默认折叠） */}
            <Drawer
              open={openRaw}
              onToggle={() => setOpenRaw(v => !v)}
              label="原文"
              actions={
                md !== null && !loading ? (
                  editing ? (
                    <button className="td-chip is-on" onClick={save} title="保存计划文档">
                      <Check size={11} /> 保存
                    </button>
                  ) : (
                    <button
                      className="td-chip"
                      onClick={() => {
                        setDraft(md ?? '');
                        setOpenRaw(true);
                        setEditing(true);
                      }}
                      title="编辑计划源码"
                    >
                      <Pencil size={11} /> 编辑
                    </button>
                  )
                ) : undefined
              }
            >
              {editing ? (
                <textarea
                  className="td-plandoc__editor"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  spellCheck={false}
                />
              ) : (
                <div className="td-plandoc__view">
                  {/* checkbox 行渲染为 ✓/□（Markdown 组件无 GFM tasklist） */}
                  <Markdown content={md?.replace(/^- \[x\] /gm, '✓ ').replace(/^- \[ \] /gm, '□ ') ?? ''} />
                </div>
              )}
            </Drawer>
          </>
        )}
      </div>

      {/* 验收 diff（基线→自检，人眼核对 agent 实际改动） */}
      <Modal
        isOpen={diffOpen}
        onClose={() => setDiffOpen(false)}
        title={`改动 · ${task.title}`}
        size="xlarge"
      >
        <pre className="td-plandoc__diff">{diffLoading ? '加载中…' : diffText}</pre>
      </Modal>
    </div>
  );
};

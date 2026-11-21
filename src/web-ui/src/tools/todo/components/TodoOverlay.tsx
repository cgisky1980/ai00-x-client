/**
 * TodoOverlay — 「策」常驻运行时（服务宿主，App.tsx 挂载在 overlay 窗口里）。
 *
 * **本组件不渲染任何 UI**（`return null`）。它承担的是「窗口关掉也要继续跑」的那部分：
 * 数据加载 + XP profile 初始化 + 常驻提醒 ticker + agent 执行看门狗（30s 轮询 /
 * AI 卡死判定 / 自动恢复）+ DSH mux 订阅（提问与审批）+ 专注会话事件并入。
 *
 * 完整看板 UI 在独立 `todo` 窗口里（`src/app/TodoWindowApp.tsx` → `TodoPanel`）。
 * 两者靠 `initTodoWindowSync` 对齐状态：本组件是 `agentRunning` / `agentFailed` /
 * `agentQuestions` 的唯一 owner，单向广播给 UI 窗口。
 *
 * 为什么不把这一坨一起搬进独立窗口：窗口一关，到点提醒与卡死自动恢复就全停了。
 */
import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTodoStore } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import { useReminderTicker } from '../hooks/useReminderTicker';
import { XpKinds, type FocusSession, type TodoTask } from '../api/types';
import { connectMux, deriveSessionRunState, dshApproval, dshSession, type DshMuxFrame, type DshSessionRunState } from '@/infrastructure/api/service-api/DshAPI';
import { isApprovalAllowed } from '@/shared/agent-approval-rules';
import {
  buildRecoverPromptForTask,
  judgeModelFor,
  judgeStall,
  WATCH_CHILD_STALL_MS,
  WATCH_JUDGE_MIN_INTERVAL_MS,
  WATCH_MAX_DELAY_MS,
  WATCH_MAX_RECOVER,
  WATCH_STALL_SOFT_MS,
} from '../utils/watchdog';
import { buildChildStallPrompt } from '../ai/prompts';
import { initTodoWindowSync } from '../sync/todoWindowSync';
import { dismissTaskNotification, goToTask, notifyTask } from '../utils/notify';
import { continueTaskRun } from '../utils/continueRun';
import { invoke } from '@tauri-apps/api/core';

/**
 * 「继续执行」动作：不动窗口，直接给会话补一条按计划续跑的消息（与计划卡同一份话术）。
 *
 * 停住的任务最常见的下一步就是「接着跑」——以前必须开工作台、等面板加载、再点一次；
 * 窗口冷启动就要十几秒，通知的价值被这段路吃掉。失败时回一条 error 通知，不做静默。
 */
function resumeTask(task: TodoTask, variant: 'primary' | 'secondary' = 'primary'): {
  label: string;
  variant: 'primary' | 'secondary';
  onClick: () => void;
} {
  return {
    label: '继续执行',
    variant,
    onClick: () => {
      void invoke<string | null>('todo_plan_get', { taskId: task.id })
        .catch(() => null)
        .then((plan) => continueTaskRun(task, plan))
        .catch((e) =>
          notifyTask('继续执行失败', String(e).slice(0, 160), 'error', [
            goToTask(task.id, '去查看'),
          ]),
        );
    },
  };
}

/**
 * 失败原因的一句话摘要（通知用）：`code · 首个分句`，超长截断。
 *
 * 只写「以错误收尾」等于让人再开窗口找出错原因；完整原文仍在卡片/对话里，
 * 通知里给到「是哪一类错、报在哪」就够判断了。
 */
function summarizeFailure(err?: { code?: string; message?: string }): string {
  if (!err) return '';
  const clause = (err.message ?? '').split(/[;；]/)[0].trim();
  const short = clause.length > 80 ? `${clause.slice(0, 80)}…` : clause;
  return [err.code, short].filter(Boolean).join(' · ');
}

// ---- 执行看门狗（AI 评估 + 自适应复查，无绝对时间强制干预）----
// 软阈值（5m 无事件）→ 派评估 agent 判断「正常长任务 vs 卡死」并给 ETA：
// 判卡死 → 自动中断 + 发「继续」（上限 2 次，超过转人工）；
// 判正常 → 按 ETA（无 ETA 翻倍、封顶 1h）自适应拉长复查间隔——
// 训练/编译跑几小时也不会被误杀；等人工场景（ask_user 待答/审批挂起）豁免。

export const TodoOverlay: React.FC = () => {
  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const initGrowth = useGrowthStore((s) => s.init);
  const setAgentRunning = useTodoStore((s) => s.setAgentRunning);
  const setAgentFailed = useTodoStore((s) => s.setAgentFailed);
  const tasks = useTodoStore((st) => st.data.tasks);
  // 看门狗运行态（非持久化）：会话最近事件时间 + 已自动恢复次数
  const activityRef = useRef(new Map<string, number>());
  const recoveriesRef = useRef(new Map<string, number>());
  // 软阈值已告警标记（每个卡住周期只提醒一次）
  const warnedRef = useRef(new Set<string>());
  // AI 评估流运行态：评估中 / 上次评估时间 / 复查间隔（自适应：ETA 或翻倍）
  const judgingRef = useRef(new Set<string>());
  const lastJudgeAtRef = useRef(new Map<string, number>());
  const judgeDelayRef = useRef(new Map<string, number>());
  // 合法等人工的场景（不算卡死）：工具审批挂起（approval/requested 未决）
  const awaitingApprovalRef = useRef(new Set<string>());
  // 首次轮询标记（启动中断提醒用一次）
  const firstPollRef = useRef(true);
  // 失败态基线（启动时的历史失败只进基线，不弹通知）
  const failedSeededRef = useRef(false);
  /**
   * 会话 → 已经报过的那份失败的 `updatedAt`。
   *
   * 以前记的是布尔（只报 false→true），但「继续执行」重试后很可能在下一次轮询前
   * 就又整轮跑完并失败——false 的中间态根本没被采样到，于是第二次失败静默消失。
   * 改成记「哪一次写入的失败已报过」：同一份失败不重复弹，新的失败（updatedAt 变了）
   * 一定再弹一次。
   */
  const notifiedFailureStampRef = useRef(new Map<string, number>());
  /** 任务 → 最近一条「任务出错」通知 id：同一张卡反复失败时先收旧条，不叠一摞。 */
  const failureToastRef = useRef(new Map<string, string>());
  /** 会话 → 提问通知 id：问一次只留一条，答完即收（同一时刻允许覆盖）。 */
  const questionToastRef = useRef(new Map<string, string>());
  /** 本次运行里见过在跑的会话（父会话含「有子代理在跑」）：只在它们身上判「停住」。 */
  const seenRunningRef = useRef(new Set<string>());
  /** 任务 → 连续判定为「停住」的轮询次数（≈30s/次）。 */
  const idlePollsRef = useRef(new Map<string, number>());
  /** 任务 → 「任务停下」通知 id：恢复运行/改状态后收起。 */
  const stallToastRef = useRef(new Map<string, string>());
  /** 子代理会话 → 处理阶段：1 = 已请 agent 中断自查，2 = 已转人工（不再重复提示）。 */
  const childStallRef = useRef(new Map<string, 1 | 2>());
  /** 子代理会话 → 转人工通知 id：子代理恢复/结束后收起。 */
  const childStallToastRef = useRef(new Map<string, string>());
  /** 任务 → 「计划 · 需要你」通知 id：批准/归档/完成后收起（不靠 8s 自动消失）。 */
  const planToastRef = useRef(new Map<string, string>());
  /** 任务 → 「审核 · 需要你」通知 id：验收/打回/归档后收起。 */
  const acceptToastRef = useRef(new Map<string, string>());
  /** 会话 → 上次历史重放结论（updatedAt 未变就复用，避免每 30s 重放几百条事件）。 */
  const historyCacheRef = useRef(new Map<string, { updatedAt: number; state: DshSessionRunState }>());

  useEffect(() => {
    void load();
    void initGrowth();
  }, [load, initGrowth]);

  // 跨窗口同步：本窗口是 agent 运行态的唯一 owner（30s 轮询与 DSH mux 都只在这里），
  // 状态变化单向广播给独立「策」窗口；反向接收 UI 侧解析出的计划步骤/验收进度，
  // 供下面的看门狗 AI 评估作为「执行到哪一步」的上下文。
  useEffect(() => initTodoWindowSync('runtime'), []);

  // 专注会话并入：underlay 番茄钟完成 → Rust 落盘 + 广播 → 内存并入 + XP（1 XP/分钟，封顶 50）
  useEffect(() => {
    const un = listen<FocusSession>('todo-focus-appended', (e) => {
      const s = e.payload;
      if (!s || typeof s.startedAt !== 'number') return;
      useTodoStore.getState().mergeFocusSession({
        taskId: s.taskId ?? null,
        startedAt: s.startedAt,
        minutes: Number(s.minutes) || 0,
        outcome: s.outcome ?? null,
      });
      const minutes = Math.max(1, Math.min(50, Number(s.minutes) || 1));
      void useGrowthStore
        .getState()
        .addXp(XpKinds.focusDone, minutes, { startedAt: s.startedAt })
        .then(() => useGrowthStore.getState().checkBadges());
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // 连续奖励结算：次日首次打开面板时 streak×2（一次性）
  useEffect(() => {
    if (!loaded) return;
    const { data, save } = useTodoStore.getState();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (data.lastStreakSettleDate === todayStr) return;
    useTodoStore.setState((s) => ({ data: { ...s.data, lastStreakSettleDate: todayStr } }));
    save();
    // 连续奖励基于服务器 dayChecks（growthStore init 已拉取）
    const { profile, addXp } = useGrowthStore.getState();
    if (profile.streak >= 2) {
      void addXp('todo.streak_bonus', profile.streak * 2, { streak: profile.streak });
    }
  }, [loaded]);

  // agent 侧 todo 写入（ai00_task_complete / ai00_todo_write / ai00_task_create）
  // → 宿主广播 → 重读盘同步内存态（load 内部 save 幂等无害）。
  // 自检提交（agentCompletedAt 新出现）→ 弹「审核 · 需要你」（产物清单 + 链接
  // 在计划面板交付物抽屉）。
  //
  // 只提示**新出现**的待验收：首帧把已有状态记为已知，否则一启动（或重启后第一条
  // 无关广播）就会把历史上所有待验收任务连弹一遍——实测 3 条任务弹 3 个 toast。
  const knownCompletedRef = useRef<Set<string>>(new Set());
  const completedSeededRef = useRef(false);
  useEffect(() => {
    if (!loaded || completedSeededRef.current) return;
    completedSeededRef.current = true;
    const seed = new Set<string>();
    for (const t of useTodoStore.getState().data.tasks) {
      if (t.agentCompletedAt && !t.completedAt) seed.add(t.id);
    }
    knownCompletedRef.current = seed;
  }, [loaded]);
  useEffect(() => {
    const un = listen('todo-agent-updated', () => {
      void useTodoStore.getState().load().then(() => {
        const { data } = useTodoStore.getState();
        const current = new Set<string>();
        const fresh: typeof data.tasks = [];
        for (const t of data.tasks) {
          if (!t.agentCompletedAt || t.completedAt) continue;
          // 已归档 = 人主动收起了这张卡：它的验收入口在只读视图里，提示过去也验收不了。
          if (t.archivedAt) continue;
          current.add(t.id);
          if (!knownCompletedRef.current.has(t.id)) fresh.push(t);
        }
        knownCompletedRef.current = current;
        // 首帧种子还没建好就到达的广播：只记状态、不补发历史提示。
        if (!completedSeededRef.current || fresh.length === 0) return;
        if (fresh.length === 1) {
          const t = fresh[0];
          // 等验收是**轮到人**的信号：常驻到验收/打回为止（8s 自动消失等于白弹），
          // 同一张卡重复自检先收旧条，不叠一摞。
          const previous = acceptToastRef.current.get(t.id);
          if (previous) dismissTaskNotification(previous);
          acceptToastRef.current.set(
            t.id,
            notifyTask(
              '审核 · 需要你',
              `「${t.title}」已自检${t.deliverables?.length ? ` · ${t.deliverables.length} 项交付物` : ''}，等你验收`,
              'warning',
              [goToTask(t.id, '去验收')],
              { duration: 0 },
            ),
          );
          return;
        }
        // 同一刻有多条（两个 worker 同时收口等）：合成一条，别叠一摞
        const names = fresh
          .slice(0, 2)
          .map((t) => `「${t.title.slice(0, 14)}」`)
          .join('、');
        notifyTask(
          '审核 · 需要你',
          `${fresh.length} 个任务等你验收：${names}${fresh.length > 2 ? ' 等' : ''}`,
          'warning',
          [goToTask(fresh[0].id, '去验收')],
        );
      });
    });
    return () => {
      void un.then(f => f());
    };
  }, []);

  // 计划落盘 → 若这份计划还没被人批准（首次成文，或 agent 改了目标/步骤/验收措辞
  // 导致批准复位），弹一次「待批准」：否则人在别的场景里根本不知道轮到自己了。
  // 冷却 5 分钟：agent 在批准前反复调整计划时不要连着刷。
  const approvalToastAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    const un = listen<{ taskId: string }>('todo-plan-updated', (event) => {
      const taskId = event.payload?.taskId;
      if (!taskId) return;
      // 计划写盘与「批准复位」是两次写入（plan → todo），等后者落定再判；
      // 这里只读内存态（todo-agent-updated 会负责重读盘），不额外读文件。
      window.setTimeout(() => {
        const task = useTodoStore.getState().data.tasks.find((t) => t.id === taskId);
        if (!task || task.origin !== 'workbench') return;
        // 已归档的卡不弹：验收/批准入口都在只读视图里，提示过去也动不了。
        if (task.archivedAt) return;
        if (task.completedAt || task.agentCompletedAt || task.planApprovedAt) return;
        const at = approvalToastAtRef.current.get(taskId) ?? 0;
        if (Date.now() - at < 5 * 60_000) return;
        approvalToastAtRef.current.set(taskId, Date.now());
        // 批准是「轮到人」的信号，常驻到批准/改计划/归档为止；同一张卡先收旧条。
        const previous = planToastRef.current.get(taskId);
        if (previous) dismissTaskNotification(previous);
        planToastRef.current.set(
          taskId,
          notifyTask(
            '计划 · 需要你',
            `「${task.title}」的计划等你批准后开工`,
            'warning',
            [goToTask(task.id, '去批准')],
            { duration: 0 },
          ),
        );
      }, 900);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // agent 提问订阅（ask_user_question → 策内嵌问题卡，一步应答不跳主窗）：
  // 独立 mux WS 连接（与主窗 DshScene 并行；指数退避重连，引擎未起静默）。
  // 同时承担看门狗的活动信号源：任何会话事件都刷新最近活动时间。
  useEffect(() => {
    const conn = connectMux((frame: DshMuxFrame, rpcId: string) => {
      const store = useTodoStore.getState();
      if (frame.type === 'session/event') {
        activityRef.current.set(frame.sessionId, Date.now());
        // 一轮正常结束 = 模型还活着：清自动恢复计数与复查间隔（回归默认节奏）
        if (frame.event.type === 'turn/end') {
          recoveriesRef.current.delete(frame.sessionId);
          judgeDelayRef.current.delete(frame.sessionId);
        }
      } else if (frame.type === 'question/requested') {
        activityRef.current.set(frame.sessionId, Date.now());
        store.upsertAgentQuestion(frame.sessionId, { rpcId, questions: frame.questions });
        // 提问会卡住整轮：人不在工作台时也该被叫回来（列表里的「需要你」在别的窗口看不见）。
        // 常驻不自动消失——8 秒就蒸发的提示对面是一轮永不继续的执行；同一会话反复提问
        // 先收旧条（agent 往往一问接一问），答完由 question/resolved 收尾。
        const task = store.data.tasks.find(
          (t) => t.agentSessionId === frame.sessionId && !t.archivedAt && !t.completedAt,
        );
        if (task) {
          const previous = questionToastRef.current.get(frame.sessionId);
          if (previous) dismissTaskNotification(previous);
          const first = frame.questions[0]?.question?.trim() ?? '';
          const toastId = notifyTask(
            '提问 · 需要你',
            first
              ? `「${task.title}」在等你回答：${first.slice(0, 40)}`
              : `「${task.title}」有 ${frame.questions.length} 个问题等你回答`,
            'warning',
            [goToTask(task.id, '去回答')],
            { duration: 0 },
          );
          questionToastRef.current.set(frame.sessionId, toastId);
        }
      } else if (frame.type === 'question/resolved') {
        activityRef.current.set(frame.sessionId, Date.now());
        store.removeAgentQuestion(frame.sessionId, frame.questionRpcId);
        // 本轮问题全部答完（工作台答或取消都算）→ 收起提示，别留一条点不动的旧通知
        if ((useTodoStore.getState().agentQuestions[frame.sessionId]?.length ?? 0) === 0) {
          const toastId = questionToastRef.current.get(frame.sessionId);
          if (toastId) {
            questionToastRef.current.delete(frame.sessionId);
            dismissTaskNotification(toastId);
          }
        }
      } else if (frame.type === 'approval/requested') {
        activityRef.current.set(frame.sessionId, Date.now());
        // 「总是允许」记忆命中：自动应答放行，不再打扰人工
        if (isApprovalAllowed(frame.sessionId, frame.toolName)) {
          void dshApproval.respond(rpcId, frame.sessionId, frame.approvalId, 'allowed-once');
          return;
        }
        // 工具审批挂起 = 等人工点击——合法静默，看门狗豁免
        awaitingApprovalRef.current.add(frame.sessionId);
      } else if (frame.type === 'approval/resolved') {
        awaitingApprovalRef.current.delete(frame.sessionId);
        activityRef.current.set(frame.sessionId, Date.now());
      }
    });
    return () => conn.close();
  }, []);

  // agent 会话运行态轮询（30s，非持久化；引擎未起时静默）
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { items } = await dshSession.list();
        if (stopped) return;
        const map: Record<string, boolean> = {};
        for (const s of items) map[s.sessionId] = !!s.running;
        setAgentRunning(map);

        // 失败态回填（R2-9）：事件流水账重放派生——只看「最后一个轮次是否以错误收尾」，
        // 不再读历史尾找 error（折叠规则一变就漂、且工具失败被后续轮次救回也误报）
        //
        // ⚠️ 历史重放很贵（一次可能几百条事件）。以前每 30s 对**所有**停住的 doing 任务
        // 重拉一遍：十几张停滞卡 = 每分钟二十多次 history RPC，纯属空转。
        // 现在按 `session/list` 的 `updatedAt` 做缓存：会话没有新事件就直接复用上次的结论。
        const doingSessions = tasks
          .filter(t => (t.status ?? 'requirement') === 'doing' && t.agentSessionId)
          .map(t => t.agentSessionId as string);
        const updatedAtOf = new Map(items.map(s => [s.sessionId, s.updatedAt ?? 0]));
        const failedMap: Record<string, boolean> = {};
        const runStateMap: Record<string, DshSessionRunState> = {};
        for (const sid of doingSessions) {
          if (map[sid]) continue; // 仍在跑，不判
          const stamp = updatedAtOf.get(sid);
          const cached = historyCacheRef.current.get(sid);
          if (cached && stamp !== undefined && cached.updatedAt === stamp) {
            runStateMap[sid] = cached.state;
            failedMap[sid] = cached.state.lastTurnErrored;
            continue;
          }
          try {
            const { events } = await dshSession.history(sid);
            const state = deriveSessionRunState(events.map(e => e.event));
            historyCacheRef.current.set(sid, { updatedAt: stamp ?? 0, state });
            runStateMap[sid] = state;
            failedMap[sid] = state.lastTurnErrored;
          } catch {
            // 历史拉不到 → 不标（宁可不报，不误报）
          }
        }
        // 会话消失（被清理 / 换了数据目录）→ 丢掉缓存，免得 id 复用时套用旧结论
        for (const sid of [...historyCacheRef.current.keys()]) {
          if (!updatedAtOf.has(sid)) historyCacheRef.current.delete(sid);
        }
        setAgentFailed(failedMap);

        // 新一轮失败提醒：同一份失败只报一次，新的失败（updatedAt 变了）必报。
        // 以前一轮报错只落在卡片的「失败」态里，人不开卡片就完全不知道——任务静默
        // 停在执行段，也不知道该点「继续执行」。启动时的历史失败只进基线
        // （否则重启会连弹一串旧账）。
        const failedNow = new Map<string, boolean>();
        for (const task of tasks) {
          if (task.agentSessionId) failedNow.set(task.agentSessionId, failedMap[task.agentSessionId] === true);
        }
        if (failedSeededRef.current) {
          for (const task of tasks) {
            const sid = task.agentSessionId;
            if (!sid || task.archivedAt || task.completedAt) continue;
            if (!failedNow.get(sid)) continue;
            const stamp = updatedAtOf.get(sid) ?? 0;
            if (notifiedFailureStampRef.current.get(sid) === stamp) continue;
            const previous = failureToastRef.current.get(task.id);
            if (previous) dismissTaskNotification(previous);
            const reason = summarizeFailure(runStateMap[sid]?.lastError);
            const toastId = notifyTask(
              '任务出错 · 需要你',
              `「${task.title}」这一轮以错误收尾${reason ? `：${reason}` : ''}——点开卡片查看错误，或点「继续执行」重试`,
              'error',
              // 文案里让用户点「继续执行」，按钮就必须真的在：只给「去查看」等于
              // 逼人开窗口再找一次入口。整卡点击仍是「去查看」（primary）。
              [goToTask(task.id, '去查看'), resumeTask(task, 'secondary')],
            );
            failureToastRef.current.set(task.id, toastId);
            notifiedFailureStampRef.current.set(sid, stamp);
          }
        } else {
          for (const task of tasks) {
            const sid = task.agentSessionId;
            if (!sid || !failedNow.get(sid)) continue;
            notifiedFailureStampRef.current.set(sid, updatedAtOf.get(sid) ?? 0);
          }
          failedSeededRef.current = true;
        }
        // 失败已消失（回合成功 / 会话被清）→ 清掉记录，下次失败照常报
        for (const sid of [...notifiedFailureStampRef.current.keys()]) {
          if (!failedNow.get(sid)) notifiedFailureStampRef.current.delete(sid);
        }
        // 失败已恢复（重新在跑 / 回合成功 / 已验收或归档）→ 收起「任务出错」通知。
        // 它是 error 档常驻通知，不跟随状态收就会一直挂在角上说「需要你」，
        // 而任务其实早就继续跑了。查不到任务时不动（快照可能比闭包新）。
        for (const [taskId, toastId] of [...failureToastRef.current]) {
          const t = tasks.find((x) => x.id === taskId);
          if (!t) continue;
          const sid = t.agentSessionId;
          const stillFailed = !!sid && failedNow.get(sid) === true && !t.completedAt && !t.archivedAt;
          if (stillFailed) continue;
          failureToastRef.current.delete(taskId);
          dismissTaskNotification(toastId);
        }

        // 「轮到你了」的两类常驻通知：状态一变就收（批准 / 验收 / 打回 / 归档 / 删卡），
        // 否则它们会一直挂在角上，人还得自己点叉。
        // ⚠️ 任务在轮询快照里查不到时**不能**当成「已处理」：刚 reload 的新卡可能比
        // 本轮闭包里的 tasks 更新，误判会把刚弹出的通知立刻收掉（实测踩过）。
        for (const [taskId, toastId] of [...planToastRef.current]) {
          const t = tasks.find((x) => x.id === taskId);
          if (!t) continue;
          if (!t.planApprovedAt && !t.completedAt && !t.agentCompletedAt && !t.archivedAt) continue;
          planToastRef.current.delete(taskId);
          dismissTaskNotification(toastId);
        }
        for (const [taskId, toastId] of [...acceptToastRef.current]) {
          const t = tasks.find((x) => x.id === taskId);
          if (!t) continue;
          if (t.agentCompletedAt && !t.completedAt && !t.archivedAt) continue;
          acceptToastRef.current.delete(taskId);
          dismissTaskNotification(toastId);
        }

        // 回合正常结束但没有收口：agent 停了（常见话术是「已派发，等结果」，
        // 实际没有任何会话在跑），卡片只是从「执行中」变成「已停止」。
        // 不叫人的话，任务就停在执行段，谁也不知道要点「继续执行」。
        // 两条边界：只在**本次运行里见过它在跑**的任务上判（启动时的历史停滞不刷旧账）；
        // 有子代理在跑 = 还在推进，不算停住。
        const runningParents = new Set<string>();
        for (const s of items) {
          if (!s.running) continue;
          seenRunningRef.current.add(s.sessionId);
          if (s.parentSessionId) {
            runningParents.add(s.parentSessionId);
            seenRunningRef.current.add(s.parentSessionId);
          }
        }
        const questions = useTodoStore.getState().agentQuestions;
        for (const task of tasks) {
          const sid = task.agentSessionId;
          const stalled =
            Boolean(sid) &&
            task.origin === 'workbench' &&
            (task.executionMode ?? 'delivery') !== 'quick' &&
            !task.archivedAt &&
            !task.completedAt &&
            !task.agentCompletedAt &&
            (task.status ?? 'requirement') === 'doing' &&
            Boolean(task.planApprovedAt) &&
            !map[sid as string] &&
            !runningParents.has(sid as string) &&
            !failedMap[sid as string] &&
            (questions[sid as string]?.length ?? 0) === 0 &&
            seenRunningRef.current.has(sid as string);
          if (!stalled) {
            idlePollsRef.current.delete(task.id);
            const old = stallToastRef.current.get(task.id);
            if (old) {
              stallToastRef.current.delete(task.id);
              dismissTaskNotification(old);
            }
            continue;
          }
          const polls = (idlePollsRef.current.get(task.id) ?? 0) + 1;
          idlePollsRef.current.set(task.id, polls);
          // 连续两轮（≈60s）都停着才叫人：一轮的间隙里 agent 往往还在写文件/等子代理回调
          if (polls !== 2 || stallToastRef.current.has(task.id)) continue;
          stallToastRef.current.set(
            task.id,
            notifyTask(
              '任务停下 · 需要你',
              `「${task.title}」这一轮结束了，但没有自检收口，也没有子代理在跑——点「继续执行」让它按计划接着走`,
              'warning',
              [resumeTask(task), goToTask(task.id, '去查看', 'secondary')],
              { duration: 0 },
            ),
          );
        }

        // 子代理长时间无事件：worker 是子会话，主会话看门狗看不见它（主会话早已 turn/end），
        // 于是任务显示「执行中」而实际什么也没在推进（实测 sandbox `bash sleep 45` 挂 5 分钟
        // 以上不返回）。先请编排者自己中断重派（只有它有 interrupt_agent；宿主直接 cancel
        // 子会话会被引擎以「owned by subagent routing」拒绝），再犯才转人工。
        const stuckChildren = new Set<string>();
        for (const child of items) {
          const parentSid = child.parentSessionId;
          if (!parentSid || !child.running) continue;
          const parentTask = tasks.find(
            (t) =>
              t.agentSessionId === parentSid &&
              t.origin === 'workbench' &&
              !t.archivedAt &&
              !t.completedAt,
          );
          if (!parentTask) continue;
          const childIdleMs = Date.now() - (child.updatedAt ?? 0);
          if (childIdleMs < WATCH_CHILD_STALL_MS) continue;
          stuckChildren.add(child.sessionId);
          if (map[parentSid]) continue; // 主会话还在跑：可能正在与子代理交互
          const stage = childStallRef.current.get(child.sessionId);
          const childIdleMinutes = Math.round(childIdleMs / 60_000);
          if (stage === 1) {
            childStallRef.current.set(child.sessionId, 2);
            childStallToastRef.current.set(
              child.sessionId,
              notifyTask(
                '子代理卡住 · 需要你',
                `「${parentTask.title}」的子代理已经 ${childIdleMinutes} 分钟没有任何事件，已请 agent 中断仍未恢复——点开卡片看看，必要时中断任务重新规划`,
                'error',
                [goToTask(parentTask.id, '去查看')],
              ),
            );
            continue;
          }
          if (stage === 2) continue;
          childStallRef.current.set(child.sessionId, 1);
          void dshSession
            .prompt(parentSid, buildChildStallPrompt({ childId: child.sessionId, idleMinutes: childIdleMinutes }))
            .then(() =>
              notifyTask(
                '子代理无响应 · 已请 agent 处理',
                `「${parentTask.title}」的子代理已 ${childIdleMinutes} 分钟无事件，已提醒编排者中断并重新评估`,
                'info',
              ),
            )
            .catch(() => childStallRef.current.delete(child.sessionId)); // 消息送不到：下一轮再试
        }
        // 子代理恢复/结束 → 收起转人工提示并重置阶段（下次卡住重新走一遍）
        for (const [childId, toastId] of [...childStallToastRef.current]) {
          if (stuckChildren.has(childId)) continue;
          childStallToastRef.current.delete(childId);
          dismissTaskNotification(toastId);
        }
        for (const childId of [...childStallRef.current.keys()]) {
          if (!stuckChildren.has(childId)) childStallRef.current.delete(childId);
        }

        // 启动首次轮询（R2-9）：客户端退出会杀引擎——按事件重放判「被中断」：
        // 未闭合的轮次（turn/start 无 turn/end）或有工具调用未返回，才算中断；
        // 已正常收尾但等人验收的任务不再误报。
        if (firstPollRef.current) {
          firstPollRef.current = false;
          const interrupted = tasks.filter(t => {
            const sid = t.agentSessionId;
            if (t.archivedAt) return false; // 已归档：不催人处理
            if ((t.status ?? 'requirement') !== 'doing' || !sid || map[sid]) return false;
            const state = runStateMap[sid];
            return state ? state.openTurn || state.pendingTools > 0 : false;
          });
          if (interrupted.length) {
            notifyTask(
              `有 ${interrupted.length} 个执行任务被中断`,
              '上次客户端退出时中断——点开卡片查看，直接发消息或点「继续执行」续跑',
              'warning',
              [goToTask(interrupted[0].id, '去查看')],
            );
          }
          // 还有一种「重启后静默停住」：上一轮**正常结束**却没自检收口（轮次是闭合的，
          // 不算中断），而「任务停下」只认本次运行里见过的会话——不在这里合并报一次，
          // 这些卡就永远只是列表里一个「已停止」，没人知道要推它。合并成一条，不刷屏。
          const questionsAtStart = useTodoStore.getState().agentQuestions;
          const stalledAtStart = tasks.filter((t) => {
            const sid = t.agentSessionId;
            return (
              Boolean(sid) &&
              t.origin === 'workbench' &&
              (t.executionMode ?? 'delivery') !== 'quick' &&
              !t.archivedAt &&
              !t.completedAt &&
              !t.agentCompletedAt &&
              (t.status ?? 'requirement') === 'doing' &&
              Boolean(t.planApprovedAt) &&
              !map[sid as string] &&
              !failedMap[sid as string] &&
              (questionsAtStart[sid as string]?.length ?? 0) === 0
            );
          });
          if (stalledAtStart.length > 0) {
            const names = stalledAtStart
              .slice(0, 2)
              .map((t) => `「${t.title.slice(0, 14)}」`)
              .join('、');
            notifyTask(
              `有 ${stalledAtStart.length} 个任务停在执行段`,
              `${names}${stalledAtStart.length > 2 ? ' 等' : ''}上次停在半路没自检收口——点开卡片按计划继续`,
              'warning',
              [goToTask(stalledAtStart[0].id, '去查看')],
            );
          }
        }

        // 执行看门狗（AI 评估流）：软阈值静默 → 派评估 agent 判断；判卡死/
        // 连续正常超限/静默超 FORCE → 自动恢复或转人工
        const doingTaskMap = new Map(
          tasks
            .filter(t => (t.status ?? 'requirement') === 'doing' && t.agentSessionId)
            .map(t => [t.agentSessionId as string, t]),
        );
        for (const [sid, task] of doingTaskMap) {
          if (!map[sid]) {
            recoveriesRef.current.delete(sid);
            warnedRef.current.delete(sid);
            judgingRef.current.delete(sid);
            continue;
          }
          // 合法等人工的场景不算卡死：ask_user_question 待答 / 工具审批挂起。
          // 等待期不计时（刷新基线），人答完后的恢复帧会继续刷活动。
          const waitingHuman =
            (useTodoStore.getState().agentQuestions[sid]?.length ?? 0) > 0 ||
            awaitingApprovalRef.current.has(sid);
          if (waitingHuman) {
            recoveriesRef.current.delete(sid);
            warnedRef.current.delete(sid);
            activityRef.current.set(sid, Date.now());
            continue;
          }
          // 首次见到该会话：先给一个完整阈值的观察窗（避免中途开面板误判）
          if (!activityRef.current.has(sid)) {
            activityRef.current.set(sid, Date.now());
            continue;
          }
          const idleMs = Date.now() - (activityRef.current.get(sid) ?? 0);
          if (idleMs < WATCH_STALL_SOFT_MS) {
            warnedRef.current.delete(sid);
            continue;
          }
          if (judgingRef.current.has(sid)) continue; // 评估中

          /** 恢复动作（带评估理由；次数用尽 → 标失败转人工）。 */
          const recoverNow = (why: string): void => {
            const count = recoveriesRef.current.get(sid) ?? 0;
            if (count >= WATCH_MAX_RECOVER) {
              recoveriesRef.current.delete(sid);
              const cur = useTodoStore.getState().agentFailed;
              useTodoStore.getState().setAgentFailed({ ...cur, [sid]: true });
              notifyTask(
                '执行卡住 · 需要人工处理',
                `${why}——自动恢复次数已用完，点开卡片干预或重新规划`,
                'error',
              );
              return;
            }
            recoveriesRef.current.set(sid, count + 1);
            activityRef.current.set(sid, Date.now());
            const attempt = count + 1;
            void (async () => {
              try {
                await dshSession.cancel(sid); // 中断卡住的轮次
                // R1-2：恢复词带进度快照（计划勾选状态 + 近期工具动作）
                const recoverPrompt = await buildRecoverPromptForTask(task.id, sid, why);
                await dshSession.prompt(sid, recoverPrompt);
                notifyTask(`执行卡住 · 已自动恢复（第 ${attempt} 次）`, why, 'info');
              } catch {
                // 引擎不可达等 → 下个观察窗再试
              }
            })();
          };

          // 自适应复查：距上次评估不满当前间隔（按 ETA/翻倍拉长）→ 等下一轮
          const delay = judgeDelayRef.current.get(sid) ?? WATCH_JUDGE_MIN_INTERVAL_MS;
          if (Date.now() - (lastJudgeAtRef.current.get(sid) ?? 0) < delay) continue;

          // 派评估 agent（模型 = 卡片讨论模型）
          lastJudgeAtRef.current.set(sid, Date.now());
          judgingRef.current.add(sid);
          const idleMinutes = Math.round(idleMs / 60_000);
          void (async () => {
            try {
              const j = await judgeStall({
                taskId: task.id,
                title: task.title,
                sid,
                idleMinutes,
                currentStep: useTodoStore.getState().planSteps[task.id]?.current ?? null,
                model: judgeModelFor(task),
              });
              judgingRef.current.delete(sid);
              if (!j) {
                // 评估不可用 → 人工提醒 + 保持最小间隔重试
                judgeDelayRef.current.set(sid, WATCH_JUDGE_MIN_INTERVAL_MS);
                activityRef.current.set(sid, Date.now());
                if (!warnedRef.current.has(sid)) {
                  warnedRef.current.add(sid);
                  notifyTask(
                    `执行静默 ${idleMinutes} 分钟 · 暂无法自动评估`,
                    '请人工留意：点开卡片查看，或在对话里发一句话让它继续',
                    'warning',
                  );
                }
                return;
              }
              if (j.verdict === 'stuck') {
                judgeDelayRef.current.delete(sid);
                recoverNow(`AI 评估判定卡死（静默 ${idleMinutes} 分钟）${j.reason ? `：${j.reason}` : ''}`);
                return;
              }
              // 判正常：按 ETA（缺省翻倍）自适应拉长复查间隔——绝不强制干预
              const etaBased = j.etaMinutes && j.etaMinutes > 0 ? j.etaMinutes * 1.2 * 60_000 : delay * 2;
              judgeDelayRef.current.set(
                sid,
                Math.min(Math.max(etaBased, WATCH_JUDGE_MIN_INTERVAL_MS), WATCH_MAX_DELAY_MS),
              );
              activityRef.current.set(sid, Date.now());
              notifyTask(
                'AI 评估：正常长任务',
                `预计还需 ${j.etaMinutes ?? '?'} 分钟${j.reason ? `——${j.reason}` : ''}，到时自动复查`,
                'info',
              );
            } catch {
              judgingRef.current.delete(sid);
            }
          })();
        }
      } catch {
        // 引擎未启动/接口不可用 → 保留上次态
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [loaded, setAgentRunning, setAgentFailed, tasks]);

  useReminderTicker();

  // 纯运行时宿主：UI 在独立「策」窗口（src/app/TodoWindowApp.tsx）
  return null;
};

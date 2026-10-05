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
import { XpKinds, type FocusSession } from '../api/types';
import { connectMux, deriveSessionRunState, dshApproval, dshSession, type DshMuxFrame, type DshSessionRunState } from '@/infrastructure/api/service-api/DshAPI';
import { isApprovalAllowed } from '@/shared/agent-approval-rules';
import {
  buildRecoverPromptForTask,
  judgeModelFor,
  judgeStall,
  WATCH_JUDGE_MIN_INTERVAL_MS,
  WATCH_MAX_DELAY_MS,
  WATCH_MAX_RECOVER,
  WATCH_STALL_SOFT_MS,
} from '../utils/watchdog';
import { initTodoWindowSync } from '../sync/todoWindowSync';

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
  // 自检提交（agentCompletedAt 新出现）→ 弹「待验收」toast（产物清单 + 链接
  // 在计划面板交付物抽屉）。
  const knownCompletedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const un = listen('todo-agent-updated', () => {
      void useTodoStore.getState().load().then(() => {
        const { data } = useTodoStore.getState();
        const current = new Set<string>();
        for (const t of data.tasks) {
          if (!t.agentCompletedAt || t.completedAt) continue;
          current.add(t.id);
          if (!knownCompletedRef.current.has(t.id)) {
            useGrowthStore.getState().showToast(
              '待验收',
              `「${t.title}」已自检${t.deliverables?.length ? ` · ${t.deliverables.length} 项交付物` : ''}`,
            );
          }
        }
        knownCompletedRef.current = current;
      });
    });
    return () => {
      void un.then(f => f());
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
      } else if (frame.type === 'question/resolved') {
        activityRef.current.set(frame.sessionId, Date.now());
        store.removeAgentQuestion(frame.sessionId, frame.questionRpcId);
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
        const doingSessions = tasks
          .filter(t => (t.status ?? 'requirement') === 'doing' && t.agentSessionId)
          .map(t => t.agentSessionId as string);
        const failedMap: Record<string, boolean> = {};
        const runStateMap: Record<string, DshSessionRunState> = {};
        for (const sid of doingSessions) {
          if (map[sid]) continue; // 仍在跑，不判
          try {
            const { events } = await dshSession.history(sid);
            const state = deriveSessionRunState(events.map(e => e.event));
            runStateMap[sid] = state;
            failedMap[sid] = state.lastTurnErrored;
          } catch {
            // 历史拉不到 → 不标（宁可不报，不误报）
          }
        }
        setAgentFailed(failedMap);

        // 启动首次轮询（R2-9）：客户端退出会杀引擎——按事件重放判「被中断」：
        // 未闭合的轮次（turn/start 无 turn/end）或有工具调用未返回，才算中断；
        // 已正常收尾但等人验收的任务不再误报。
        if (firstPollRef.current) {
          firstPollRef.current = false;
          const interrupted = tasks.filter(t => {
            const sid = t.agentSessionId;
            if ((t.status ?? 'requirement') !== 'doing' || !sid || map[sid]) return false;
            const state = runStateMap[sid];
            return state ? state.openTurn || state.pendingTools > 0 : false;
          });
          if (interrupted.length) {
            useGrowthStore
              .getState()
              .showToast(
                `有 ${interrupted.length} 个执行任务被中断`,
                '上次客户端退出时中断——点开卡片查看，直接发消息或点「继续执行」续跑',
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
              useGrowthStore
                .getState()
                .showToast('执行卡住 · 需要人工处理', `${why}——自动恢复次数已用完，点开卡片干预或重新规划`);
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
                useGrowthStore
                  .getState()
                  .showToast(`执行卡住 · 已自动恢复（第 ${attempt} 次）`, why);
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
                  useGrowthStore
                    .getState()
                    .showToast(
                      `执行静默 ${idleMinutes} 分钟 · 暂无法自动评估`,
                      '请人工留意；可点开卡片用「中断并继续」',
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
              useGrowthStore
                .getState()
                .showToast(
                  'AI 评估：正常长任务',
                  `预计还需 ${j.etaMinutes ?? '?'} 分钟${j.reason ? `——${j.reason}` : ''}，到时自动复查`,
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

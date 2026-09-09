/**
 * TodoOverlay — todo 核心功能根组件「策」（App.tsx 挂载）。
 *
 * 职责：数据加载 + XP profile 初始化 + 常驻提醒 ticker + 面板渲染
 * + 专注会话事件并入（underlay 番茄钟 → Rust todo_focus_append → 此处入账 XP）。
 * 面板关闭时数据与提醒仍在跑（60s ticker 与面板开关无关）。
 */
import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTodoStore } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import { useReminderTicker } from '../hooks/useReminderTicker';
import { XpKinds, type FocusSession } from '../api/types';
import { connectMux, dshSession, foldEvents, type DshMuxFrame } from '@/infrastructure/api/service-api/DshAPI';
import {
  judgeModelFor,
  judgeStall,
  WATCH_JUDGE_MIN_INTERVAL_MS,
  WATCH_MAX_DELAY_MS,
  WATCH_MAX_RECOVER,
  WATCH_RECOVER_PROMPT,
  WATCH_STALL_SOFT_MS,
} from '../utils/watchdog';
import { TodoPanel } from './TodoPanel';

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
  // → 宿主广播 → 重读盘同步内存态（load 内部 save 幂等无害）
  useEffect(() => {
    const un = listen('todo-agent-updated', () => {
      void useTodoStore.getState().load();
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
        // 工具审批挂起 = 等人工点击——合法静默，看门狗豁免
        activityRef.current.set(frame.sessionId, Date.now());
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

        // 失败态回填：doing 任务的会话已停止 → 拉历史尾判最后一轮成败
        const doingSessions = tasks
          .filter(t => (t.status ?? 'requirement') === 'doing' && t.agentSessionId)
          .map(t => t.agentSessionId as string);
        const failedMap: Record<string, boolean> = {};
        for (const sid of doingSessions) {
          if (map[sid]) continue; // 仍在跑，不判
          try {
            const { events } = await dshSession.history(sid);
            const msgs = foldEvents(events.map(e => e.event));
            const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user');
            const tail = msgs.slice(lastUserIdx + 1);
            failedMap[sid] = tail.some(
              m => Boolean(m.error) || m.toolCalls.some(tc => tc.isError),
            );
          } catch {
            // 历史拉不到 → 不标
          }
        }
        setAgentFailed(failedMap);

        // 启动首次轮询：客户端退出会杀引擎——进行中的执行任务全部中断，提醒人接管
        if (firstPollRef.current) {
          firstPollRef.current = false;
          const interrupted = tasks.filter(
            t =>
              (t.status ?? 'requirement') === 'doing' &&
              t.agentSessionId &&
              !t.completedAt &&
              !t.agentCompletedAt &&
              !map[t.agentSessionId as string],
          );
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
                await dshSession.prompt(sid, `${WATCH_RECOVER_PROMPT}\n（检测依据：${why}）`);
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

  if (!loaded) return null;
  return <TodoPanel />;
};

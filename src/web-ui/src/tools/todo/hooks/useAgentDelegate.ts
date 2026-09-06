/**
 * useAgentDelegate — 策卡片 → dsh agent 委托交付（人机对等计划体）。
 *
 * 模块化（M1.3/M4.1）：delegate(task, moduleId?) 按 agent-modules 注册表
 * 解析模块；module.preset 非空时作为 agentPreset 传给 session.create
 * （dsh 引擎原生参数，Rust 侧 .agent-presets 预置同名 preset）。
 * 流程：session.create → prompt（模块职责 + 计划契约任务书 + 完成自标指示）
 * → 回写卡片（agentModule/agentSessionId/status: doing）→ 唤起主窗 Agent 场景。
 */
import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  dshSession,
  dshEngine,
} from '@/infrastructure/api/service-api/DshAPI';
import { getAgentModule } from '../agent-modules';
import type { TodoTask } from '../api/types';
import { useTodoStore } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import {
  getDefaultWorkspace,
  pickWorkspaceDir,
  resolveDelegateCwd,
  setDefaultWorkspace,
} from '../ai/workspace';

export function useAgentDelegate() {
  const busyRef = useRef(false);

  const delegate = useCallback(async (task: TodoTask, moduleId?: string) => {
    if (busyRef.current) return false;
    // 模块解析：显式 moduleId 优先，缺省普通 agent（preset: '' 用默认）
    const module = getAgentModule(moduleId) ?? getAgentModule('agent');
    if (!module) return false;
    busyRef.current = true;
    try {
      // 1. 引擎就绪
      await dshEngine.ensureReady().catch(() => undefined);

      // 2. cwd 解析链（cwd 策略 none 的模块跳过——壁纸等无需工作目录）：
      //    志目录 > 默认工作区；两者皆无且未设置过默认 → 首次引导
      //    选一次（挑过持久化不再问；取消则本次不带 cwd，行为同旧版）
      let cwd: string | null = null;
      if (module.cwd === 'ask') {
        cwd = resolveDelegateCwd(useTodoStore.getState().data, task.goalId);
        if (!cwd && !getDefaultWorkspace()) {
          cwd = await pickWorkspaceDir();
          if (cwd) setDefaultWorkspace(cwd);
        }
      }

      // 3. 创建会话（cwd/agentPreset 缺省必须省略字段——引擎对 '' 做 mkdir 报 ENOENT）
      const { sessionId } = await dshSession.create({
        ...(cwd ? { cwd } : {}),
        ...(module.preset ? { agentPreset: module.preset } : {}),
      });
      // M1.4 VRAM 联动：会话创建即上报 agent 活动上下文 → 预测 warmup 本地 RWKV
      await invoke('vram_set_active_context', { context: 'agent' }).catch(() => undefined);

      // 3.5 委托前基线快照（auto-init 静默；失败不阻塞委托）
      if (cwd) {
        await invoke('git_snapshot', {
          request: { dir: cwd, message: `task: ${task.title.slice(0, 60)} · 委托基线` },
        }).catch(() => undefined);
      }

      // 4. 任务书（契约即任务书）：优先读计划 MD 现文——replan 后的改动直接生效；
      //    读不到再退化用 task.plan 结构化快照
      let taskBrief: string;
      let hasPlanDoc = false;
      const planMd = await invoke<string | null>('todo_plan_get', { taskId: task.id }).catch(
        () => null
      );
      if (planMd && planMd.trim()) {
        hasPlanDoc = true;
        taskBrief = planMd;
      } else if (task.plan) {
        hasPlanDoc = true;
        taskBrief = [
          ...(task.plan.goal ? [`目标：${task.plan.goal}`] : []),
          ...(task.plan.tasks.length
            ? ['步骤：', ...task.plan.tasks.map((t, i) => `${i + 1}. ${t.title}${t.notes ? ` — ${t.notes}` : ''}`)]
            : []),
          ...(task.plan.acceptance.length
            ? [
                '验收标准（完成后逐项自检，并在计划文档「## 验收」段把对应项勾为 `- [x]`）：',
                ...task.plan.acceptance.map((a, i) => `${i + 1}. ${a}`),
              ]
            : []),
          ...(task.plan.deliverable ? [`交付物：${task.plan.deliverable}`] : []),
        ].join('\n');
      } else {
        taskBrief = `${task.title}${task.notes ? `\n\n${task.notes}` : ''}`;
      }

      const prompt = [
        module.promptPrefix,
        `任务书：${task.title}`,
        taskBrief,
        ...(cwd ? [`工作目录：${cwd}（文件读写在此目录下进行）`] : []),
        ...(hasPlanDoc
          ? [
              `计划文档可读写（与用户共享，策窗口实时可见）：先用 ai00_plan_read（taskId: "${task.id}"）读取全文；执行中把进度勾选、关键变更、结果记录更新回计划文档（ai00_plan_write 全量写回）。`,
            ]
          : []),
        `完成后调用 ai00_task_complete 工具标记完成（taskId: "${task.id}"${cwd ? `，snapshotDir: "${cwd}"——完成时自动 git 快照你的全部改动，不要手动 commit` : ''}；若计划文档「## 验收」段未全勾，该工具会拒绝——先逐项自检并在文档中勾选 "- [x]"）。`,
        `执行中若发现需要新的子任务或想法，用 ai00_task_create 落入想法池（可带 sourceTaskId: "${task.id}" 标注来源、goalId 归志）——不要塞进当前计划文档的步骤段。`,
      ]
        .filter(Boolean)
        .join('\n\n');

      await dshSession.prompt(sessionId, prompt);

      // 5. 回写卡片（doing 栏 + agent 关联）
      useTodoStore.getState().updateTask(task.id, {
        agentModule: module.id,
        agentSessionId: sessionId,
        agentPrompt: prompt,
        status: 'doing',
      });

      // 6. 唤起主窗 Agent 场景
      await invoke('open_task_window', { openDsh: true }).catch(() => undefined);
      return true;
    } catch (e) {
      useGrowthStore.getState().showToast('委托失败', e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      busyRef.current = false;
    }
  }, []);

  return { delegate };
}

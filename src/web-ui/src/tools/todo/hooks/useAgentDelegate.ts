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
import { getDiscussModel, MODEL_AUTO } from '../ai/modelCatalog';
import { AIRulesAPI } from '@/infrastructure/api/service-api/AIRulesAPI';
import { getAllMemories } from '@/infrastructure/api/aiMemoryApi';
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

      // 3.2 模型一致（按卡）：把该卡讨论选定的模型应用到执行会话——并行任务
      //    可各用各的模型；未选过回落全局默认。失败不阻塞委托（会话保持默认）。
      const discussRef = task.discussModel ?? getDiscussModel();
      const modelRef = discussRef === MODEL_AUTO ? 'ai00-auto' : discussRef;
      await dshSession.selectModel(sessionId, 'ai00-x', modelRef).catch(() => undefined);

      // 3.5 委托前基线快照（auto-init 静默；失败不阻塞委托）——commit 存卡，验收 diff/回滚用
      let baseCommit: string | null = null;
      if (cwd) {
        const snap = await invoke<{ commit?: string }>('git_snapshot', {
          request: { dir: cwd, message: `task: ${task.title.slice(0, 60)} · 委托基线` },
        }).catch(() => undefined);
        baseCommit = snap?.commit ?? null;
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

      // 用户 AI 规则 + 记忆注入（与老 agent 同源；为空/失败静默——不阻塞委托）
      let rulesBlock = '';
      if (cwd) {
        try {
          const sys = await AIRulesAPI.buildSystemPrompt(cwd);
          if (sys?.trim()) rulesBlock = `【用户规则——必须遵守】\n${sys.trim().slice(0, 4000)}`;
        } catch {
          // 规则读取失败静默
        }
      }
      let memoryBlock = '';
      try {
        const mems = (await getAllMemories()).filter(m => m.enabled !== false);
        if (mems.length) {
          memoryBlock = `【用户记忆——供参考】\n${mems
            .slice(0, 20)
            .map(m => `- ${m.title}${m.content ? `：${m.content}` : ''}`.slice(0, 120))
            .join('\n')
            .slice(0, 1500)}`;
        }
      } catch {
        // 记忆读取失败静默
      }

      const prompt = [
        module.promptPrefix,
        ...(rulesBlock ? [rulesBlock] : []),
        ...(memoryBlock ? [memoryBlock] : []),
        `任务书：${task.title}`,
        taskBrief,
        ...(cwd ? [`工作目录：${cwd}（文件读写在此目录下进行）`] : []),
        ...(hasPlanDoc
          ? [
              `计划文档可读写（与用户共享，策窗口实时可见）：先用 ai00_plan_read（taskId: "${task.id}"）读取全文。执行协议：① 每完成「## 步骤」段的一个步骤，立即把对应项改为 "- [x]"（ai00_plan_write 全量写回）；② 执行中的进度、关键变更、结果记录同步更新回计划文档。`,
              `计划优先（铁律）：用户执行期间发来的消息，若涉及需求、方案、步骤或验收标准的变化，必须先把变更落入计划文档（ai00_plan_read → ai00_plan_write 更新「## 步骤」/「## 验收」等），再按更新后的计划继续执行——以计划文档为唯一依据；若只是确认、催促等无需改计划的交流，直接简短回应即可，不要为此改动计划。你自己发现方案需要变化时同此规：先改计划，再执行。`,
              `长耗时操作（编译/训练/下载等，预计超过 2 分钟）：开始前先发一句说明预计耗时（如「预计 20 分钟」），完成后再继续——策窗口按此安排检查节奏。`,
            ]
          : []),
        `全部步骤完成后逐项自检「## 验收」段（人工判据在文档中勾选 "- [x]"；带 {cmd:...} 的验证命令会自动执行），然后调用 ai00_task_complete 提交自检（taskId: "${task.id}"${cwd ? `，snapshotDir: "${cwd}"——提交时自动 git 快照你的全部改动，不要手动 commit` : ''}；验收未全勾该工具会拒绝）。提交后任务进入人类验收：不要在对话中自行宣告「已完成」，等用户在策窗口确认。`,
        `执行中若发现需要新的子任务或想法，用 ai00_task_create 落入想法池（可带 sourceTaskId: "${task.id}" 标注来源、goalId 归志）——不要塞进当前计划文档的步骤段。`,
      ]
        .filter(Boolean)
        .join('\n\n');

      await dshSession.prompt(sessionId, prompt);

      // 5. 回写卡片（doing 栏 + agent 关联）；不弹会话浮层——交流在策内
      //    进行中卡片的讨论窗/计划窗里进行（点击工灵仍可开浮层，属剧场入口）
      useTodoStore.getState().updateTask(task.id, {
        agentModule: module.id,
        agentSessionId: sessionId,
        agentPrompt: prompt,
        status: 'doing',
        agentBaseCommit: baseCommit,
        agentCommit: null, // 重置上次运行的快照/自检态
        agentCompletedAt: null,
      });
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

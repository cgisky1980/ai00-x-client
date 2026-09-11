/**
 * useAgentDelegate — 策卡片 → dsh agent 委托交付（人机对等计划体）。
 *
 * 模块化（M1.3/M4.1）：delegate(task, moduleId?) 按 agent-modules 注册表
 * 解析模块；module.preset 非空时作为 agentPreset 传给 session.create
 * （dsh 引擎原生参数，Rust 侧 .agent-presets 预置同名 preset）。
 * 流程：session.create → prompt（编排者协议：拆解任务书 → 并发派发
 * research_worker/code_worker → 验收子代理结论回写计划 → ai00_task_complete
 * 提交自检）→ 回写卡片（agentModule/agentSessionId/status: doing）→ 唤起主窗
 * Agent 场景。主对话只规划/派发/验收/沟通，不亲自调执行工具（与编排 patch
 * persona 同向加强）；计划文档读写与 ai00_task_* 是编排者保留的职责工具。
 * 会话模型不覆盖（模型解耦）：执行会话=主对话（编排者）跟随引擎默认远端；
 * worker 分工（research=ai00-auto 本地/智能路由 / code=ai00-salvo 远端）由
 * 编排 patch 自动承担；讨论模型只属于讨论通道，不泄漏到执行会话。
 */
import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  dshSession,
  dshEngine,
} from '@/infrastructure/api/service-api/DshAPI';
import { getAgentModule } from '../agent-modules';
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
    // 提升作用域：catch 兜底 cancel 用（会话已创建但后续步骤失败 → 孤儿会话）
    let sessionId: string | null = null;
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
      const created = await dshSession.create({
        ...(cwd ? { cwd } : {}),
        ...(module.preset ? { agentPreset: module.preset } : {}),
      });
      sessionId = created.sessionId;
      // M1.4 VRAM 联动：会话创建即上报 agent 活动上下文 → 预测 warmup 本地 RWKV
      await invoke('vram_set_active_context', { context: 'agent' }).catch(() => undefined);

      // 3.2 会话模型不在此覆盖（模型解耦）：执行会话是主对话（编排者），
      //    跟随引擎默认远端（agent-default-model=ai00-salvo，见
      //    dsh_manager ensure_default_model_setting）；会话内 worker 分工
      //    research_worker=ai00-auto / code_worker=ai00-salvo 由编排 patch
      //    自动承担，前端零干预。讨论模型字段只属于讨论通道。

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
        ...(cwd ? [`工作目录：${cwd}（子代理的文件读写在此目录下进行，派发时把该目录写进任务书）`] : []),
        `执行协议（编排者——你不亲自执行）：第一步先 ai00_plan_read（taskId: "${task.id}"）读取任务书全文，把「## 步骤」拆解为可派发的子任务；调研/查证类派 research_worker，实现/执行类派 code_worker，相互独立的子任务在同一条回复里并发派发。派发的每个任务写明：目标与验收标准、边界、相关文件与上下文线索、期望的返回格式（worker 看不到你们的对话，任务书必须自包含）。`,
        ...(hasPlanDoc
          ? [
              `每收到子代理完成通知：立即验收其结论，把「## 步骤」段对应项改为 "- [x]"（ai00_plan_write 全量写回），并把结果要点与遗留风险记录进计划文档；不合格就重新派发并说明问题。`,
              `计划优先（铁律）：用户执行期间发来的消息，若涉及需求、方案、步骤或验收标准的变化，必须先把变更落入计划文档（ai00_plan_read → ai00_plan_write 更新「## 步骤」/「## 验收」等），再按更新后的计划重新派发——以计划文档为唯一依据；若只是确认、催促等无需改计划的交流，直接简短回应即可。你自己发现方案需要变化时同此规：先改计划，再派发。`,
              `长耗时操作（编译/训练/下载等，预计超过 2 分钟）：收到子代理开始通知后先向用户发一句预计耗时（如「预计 20 分钟」），完成后再继续——策窗口按此安排检查节奏。`,
              `派发执行类任务时在任务书中提醒 worker：长耗时命令（预计超过 2 分钟）用 pwsh 的 run_in_background: true 参数转后台执行——立即返回任务 id，完成后引擎会自动通知，用 job_output 读取输出再继续；不要让长命令阻塞在前台。`,
            ]
          : []),
        `全部子代理完成、验收项逐项确认后（人工判据在计划文档中勾选 "- [x]"），按「完工三步」收尾：① 把交付物写成真实文件——计划「交付物」段承诺的产物必须逐一落地为工作目录下的实际文件（缺失的先让子代理补齐），纯调研/咨询任务也必须产出一份总结文件（如 report.md）；② 调用 ai00_task_complete 提交自检（taskId: "${task.id}"${cwd ? `，snapshotDir: "${cwd}"——提交时自动 git 快照工作目录的全部改动，不要手动 commit` : ''}），并带上 deliverables 参数（产物的绝对路径清单，必填）；验收未全勾该工具会拒绝；③ 提交后在会话内向用户汇报：结论摘要（≤200字）+ 产物清单（文件名 + 一句话内容）+ 待验收提示。提交后任务进入人类验收：完成状态的认定以用户在策窗口的验收为准，但结果汇报与产物清单必须主动给出，不要等用户来要。`,
        `执行中发现需要新的子任务或想法，用 ai00_task_create 落入想法池（可带 sourceTaskId: "${task.id}" 标注来源、goalId 归志）——不要塞进当前计划文档的步骤段。`,
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
      // 会话已创建但后续步骤失败 → 兜底 cancel，避免无卡片关联的孤儿会话残留
      // （DshAPI 无 delete，cancel 停止轮次；会话仍在 dsh 列表但不再耗资源）
      if (sessionId) {
        dshSession.cancel(sessionId).catch(() => undefined);
      }
      return false;
    } finally {
      busyRef.current = false;
    }
  }, []);

  return { delegate };
}

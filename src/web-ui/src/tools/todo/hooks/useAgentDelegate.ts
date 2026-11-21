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
import type { AIMemory } from '@/infrastructure/api/aiMemoryApi';
import type { TodoTask } from '../api/types';
import { useTodoStore } from '../store/todoStore';
import { notifyTask } from '../utils/notify';
import {
  getDefaultWorkspace,
  pickWorkspaceDir,
  resolveDelegateCwd,
  setDefaultWorkspace,
} from '../ai/workspace';
import { RULES_MAX_CHARS, assembleDelegationPrompt, selectRelevantMemories } from '@/agent/orchestrator';

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

      // 4. 计划文档探测（契约即任务书）：优先读计划 MD 现文——replan 后的改动
      //    直接生效；读不到再退化用 task.plan 结构化快照
      const planMd = await invoke<string | null>('todo_plan_get', { taskId: task.id }).catch(
        () => null
      );
      const hasPlanDoc = Boolean(planMd && planMd.trim());

      // 用户 AI 规则 + 记忆（R1-1 配额：规则截 4000；记忆按相关性挑 Top-5；
      // 为空/失败静默——不阻塞委托）
      let rules = '';
      if (cwd) {
        try {
          const sys = await AIRulesAPI.buildSystemPrompt(cwd);
          if (sys?.trim()) rules = sys.trim().slice(0, RULES_MAX_CHARS);
        } catch {
          // 规则读取失败静默
        }
      }
      let memories: AIMemory[] = [];
      try {
        const mems = (await getAllMemories()).filter(m => m.enabled !== false);
        memories = selectRelevantMemories(
          mems,
          `${task.title}\n${task.notes ?? ''}\n${planMd ?? ''}`,
        );
      } catch {
        // 记忆读取失败静默
      }

      // R1-3 四段任务书 + R1-5 提示词收口：组装统一走 assembleDelegationPrompt
      const prompt = assembleDelegationPrompt({
        promptPrefix: module.promptPrefix,
        rules,
        memories,
        task,
        planMd: planMd ?? null,
        cwd,
        taskId: task.id,
        hasPlanDoc,
      });

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
      notifyTask('委托失败', e instanceof Error ? e.message : String(e), 'error');
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

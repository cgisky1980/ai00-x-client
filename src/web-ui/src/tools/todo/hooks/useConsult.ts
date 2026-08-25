/**
 * useConsult — 细谈式任务创建状态机（对话澄清模式）。
 *
 * 想做什么 → AI 每轮一问（≤3 轮，本地 RWKV 单发）→ 草稿 → 确认入库。
 * 「跳过追问」随时直接生成草稿；AI 不可用降级为快速单任务。
 */
import { useCallback, useRef, useState } from 'react';
import { generateDraft, nextQuestion, type ConsultDraft } from '../ai/consult';
import { useTodoStore } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';

export type ConsultPhase = 'asking' | 'drafting' | 'draft' | 'error';

export interface ConsultState {
  open: boolean;
  phase: ConsultPhase;
  main: string;
  qa: { q: string; a: string }[];
  pendingQuestion: string | null;
  draft: ConsultDraft | null;
  error: string | null;
}

const INITIAL: ConsultState = {
  open: false,
  phase: 'asking',
  main: '',
  qa: [],
  pendingQuestion: null,
  draft: null,
  error: null,
};

export function useConsult() {
  const [state, setState] = useState<ConsultState>(INITIAL);
  const busyRef = useRef(false);

  const open = useCallback((seed: string) => {
    const main = seed.trim();
    setState({ ...INITIAL, open: true, main });
    if (main) void advance(main, []);
  }, []);

  const advance = useCallback(async (main: string, qa: { q: string; a: string }[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState((s) => ({ ...s, phase: 'asking', pendingQuestion: null }));
    try {
      const q = await nextQuestion(main, qa);
      if (q) {
        setState((s) => ({ ...s, pendingQuestion: q }));
      } else {
        // 信息足够 → 直接出草稿
        await draft(main, qa);
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const draft = useCallback(async (main: string, qa: { q: string; a: string }[]) => {
    setState((s) => ({ ...s, phase: 'drafting' }));
    const d = await generateDraft(main, qa);
    if (d) {
      setState((s) => ({ ...s, phase: 'draft', draft: d }));
    } else {
      setState((s) => ({
        ...s,
        phase: 'error',
        error: 'AI 暂不可用，可直接快速添加',
      }));
    }
  }, []);

  /** 用户回答当前问题 → 追加 QA → 追问下一问。 */
  const answer = useCallback(
    (text: string) => {
      const q = state.pendingQuestion;
      if (!q) return;
      const qa = [...state.qa, { q, a: text }];
      setState((s) => ({ ...s, qa, pendingQuestion: null }));
      void advance(state.main, qa);
    },
    [state.pendingQuestion, state.qa, state.main, advance]
  );

  /** 跳过追问，直接生成草稿。 */
  const skip = useCallback(() => {
    void draft(state.main, state.qa);
  }, [state.main, state.qa, draft]);

  const close = useCallback(() => setState(INITIAL), []);

  /** 采纳草稿入库（goalTitle 匹配现有目标名→关联，不自动建目标）。 */
  const adopt = useCallback(
    (d: ConsultDraft) => {
      const store = useTodoStore.getState();
      let goalId: string | null = null;
      if (d.goalTitle) {
        const goal = store.data.goals.find((g) => g.title.includes(d.goalTitle!) || d.goalTitle!.includes(g.title));
        if (goal) goalId = goal.id;
      }
      store.addTask(d.title, {
        notes: d.notes,
        due: d.due,
        remindAt: d.due && d.remindTime ? `${d.due}T${d.remindTime}` : null,
        repeat: d.repeat ? { type: d.repeat, afterCompletion: false } : null,
        checklist: d.checklist.map((t) => ({ t, d: false })),
        goalId,
      });
      // 细谈使用计数（勋章条件）
      try {
        const n = Number(localStorage.getItem('todo.consultCount') || 0) + 1;
        localStorage.setItem('todo.consultCount', String(n));
      } catch { /* ignore */ }
      void useGrowthStore.getState().checkBadges();
      close();
    },
    [close]
  );

  return { state, open, answer, skip, close, adopt };
}

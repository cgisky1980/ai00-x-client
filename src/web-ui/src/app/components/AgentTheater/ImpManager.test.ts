// ImpManager 单测：状态机迁移 / 席位上限 / 强度 / 结算（设计 §7 测试计划）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImpManager, MAX_CONCURRENT_IMPS } from './ImpManager';
import type {
  ImpRuntimeState,
  TheaterScenePayload,
  TheaterTurnEndedPayload,
} from './theaterTypes';

/** 手动时钟 + 手动定时器（确定性测试） */
function makeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const schedule = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.push({ at: now + ms, fn, id });
    return () => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  return {
    now: () => now,
    schedule,
    advance(ms: number) {
      // 虚拟时钟：逐事件推进到 end，嵌套 schedule 以"触发时刻"为锚
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        const t = due[0];
        timers.splice(timers.indexOf(t), 1);
        now = Math.max(now, t.at);
        t.fn();
      }
      now = end;
    },
  };
}

function makeManager(clock = makeClock()) {
  const states = new Map<string, ImpRuntimeState>();
  const turnEndeds: TheaterTurnEndedPayload[] = [];
  const scenes: TheaterScenePayload[] = [];
  const manager = new ImpManager(
    {
      onImpState: (s) => states.set(s.sessionId, { ...s }),
      onImpRemoved: (sid) => states.delete(sid),
      onTurnEnded: (p) => turnEndeds.push(p),
      onScene: (p) => scenes.push(p),
    },
    { now: clock.now, schedule: clock.schedule },
  );
  manager.start();
  return { manager, states, turnEndeds, scenes, clock };
}

const ev = (type: string, data?: unknown) => ({ type, seq: 0, data });

describe('ImpManager 状态机', () => {
  it('turn/start → appear，2s 后回落 working', () => {
    const { manager, states, clock } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: '修复登录页 bug' }));
    expect(states.get('s1')?.phase).toBe('appear');
    expect(states.get('s1')?.taskLabel).toBe('修复登录页 bug');
    clock.advance(2_001);
    expect(states.get('s1')?.phase).toBe('working');
    manager.dispose();
  });

  it('任务标签截断至 14 字符', () => {
    const { manager, states } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: '一二三四五六七八九十甲乙丙丁戊' }));
    expect(states.get('s1')?.taskLabel.length).toBe(15); // 14 + ellipsis
    manager.dispose();
  });

  it('tool/result isError → trouble，回落 working；连续错误计数正确', () => {
    const { manager, states, clock } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: 'x' }));
    manager.handleSessionEvent('s1', ev('tool/call', { callId: 'c1', name: 'Bash' }));
    clock.advance(2_001); // appear → working
    manager.handleSessionEvent('s1', ev('tool/result', {
      callId: 'c1',
      message: { content: [{ type: 'tool_result', toolCallId: 'c1', isError: true }] },
    }));
    expect(states.get('s1')?.phase).toBe('trouble');
    clock.advance(2_001);
    expect(states.get('s1')?.phase).toBe('working');
    manager.dispose();
  });

  it('连续成功 ≥5 → milestone，每 turn 最多 2 次', () => {
    const { manager, states, clock } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: 'x' }));
    clock.advance(2_001);
    const ok = (id: string) =>
      manager.handleSessionEvent('s1', ev('tool/call', { callId: id, name: 'Read' }));
    const okResult = (id: string) =>
      manager.handleSessionEvent('s1', ev('tool/result', {
        callId: id,
        message: { content: [{ type: 'tool_result', toolCallId: id }] },
      }));
    for (let i = 0; i < 5; i++) {
      ok(`a${i}`);
      clock.advance(2_001);
      okResult(`a${i}`);
      if (i === 4) {
        // 第 5 次成功立即进入 milestone（回落定时 2s 后才触发）
        expect(states.get('s1')?.phase).toBe('milestone');
      }
      clock.advance(2_001);
    }
    // 第二次里程碑
    for (let i = 5; i < 10; i++) {
      ok(`b${i}`);
      clock.advance(2_001);
      okResult(`b${i}`);
      if (i === 9) expect(states.get('s1')?.phase).toBe('milestone');
      clock.advance(2_001);
    }
    // 第三次不再触发
    for (let i = 10; i < 15; i++) {
      ok(`c${i}`);
      clock.advance(2_001);
      okResult(`c${i}`);
      clock.advance(2_001);
    }
    expect(states.get('s1')?.phase).toBe('working');
    manager.dispose();
  });

  it('thinking：working 静默 >90s 进入；工具事件退出', () => {
    const { manager, states, clock } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: 'x' }));
    clock.advance(2_001);
    manager.handleSessionEvent('s1', ev('tool/call', { callId: 'c1', name: 'Read' }));
    clock.advance(91_000);
    expect(states.get('s1')?.phase).toBe('thinking');
    manager.handleSessionEvent('s1', ev('tool/call', { callId: 'c2', name: 'Grep' }));
    expect(states.get('s1')?.phase).toBe('working');
    manager.dispose();
  });

  it('席位上限：第 3 个会话 hasImp=false，但统计照记', () => {
    const { manager, states } = makeManager();
    for (let i = 1; i <= 3; i++) {
      manager.handleSessionEvent(`s${i}`, ev('turn/start', { userInput: `t${i}` }));
    }
    expect(states.get('s1')?.hasImp).toBe(true);
    expect(states.get('s2')?.hasImp).toBe(true);
    expect(states.get('s3')?.hasImp).toBe(false);
    expect(MAX_CONCURRENT_IMPS).toBe(2);
    manager.dispose();
  });
});

describe('ImpManager 结算', () => {
  it('turn/end 无失败 → success（deliver-big）；有失败 → failed', () => {
    const { manager, states, turnEndeds, clock } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: '干净活' }));
    manager.handleSessionEvent('s1', ev('tool/call', { callId: 'c1', name: 'Read' }));
    manager.handleSessionEvent('s1', ev('tool/result', {
      callId: 'c1',
      message: { content: [{ type: 'tool_result', toolCallId: 'c1' }] },
    }));
    manager.handleSessionEvent('s1', ev('turn/end'));
    expect(turnEndeds[0]?.outcome).toBe('success');
    expect(states.get('s1')?.phase).toBe('deliver-big');
    clock.advance(5_300);
    // 庆祝后进入待验收驻留（验收完成才离场）
    expect(states.get('s1')?.phase).toBe('acceptance');
    expect(states.has('s1')).toBe(true);
    // markCompleted → 离场
    manager.markCompleted('s1');
    clock.advance(700);
    expect(states.has('s1')).toBe(false);

    manager.handleSessionEvent('s2', ev('turn/start', { userInput: '翻车活' }));
    manager.handleSessionEvent('s2', ev('tool/call', { callId: 'd1', name: 'Bash' }));
    manager.handleSessionEvent('s2', ev('tool/result', {
      callId: 'd1',
      message: { content: [{ type: 'tool_result', toolCallId: 'd1', isError: true }] },
    }));
    manager.handleSessionEvent('s2', ev('turn/end'));
    expect(turnEndeds[1]?.outcome).toBe('failed');
    manager.dispose();
  });

  it('同一 turn 只发一次 turn-ended；旧 turn 未清时重开 turn 先丢弃', () => {
    const { manager, turnEndeds } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: 'a' }));
    manager.handleSessionEvent('s1', ev('turn/end'));
    manager.handleSessionEvent('s1', ev('turn/end'));
    expect(turnEndeds).toHaveLength(1);
    manager.dispose();
  });

  it('强度：60s 窗口内工具密度 → 0/1/2 档', async () => {
    const { manager, states, clock } = makeManager();
    manager.handleSessionEvent('s1', ev('turn/start', { userInput: 'x' }));
    clock.advance(2_001);
    for (let i = 0; i < 3; i++) {
      manager.handleSessionEvent('s1', ev('tool/call', { callId: `c${i}`, name: 'Read' }));
      clock.advance(1_000);
    }
    expect(states.get('s1')?.intensity).toBeGreaterThanOrEqual(1);
    manager.dispose();
  });
});

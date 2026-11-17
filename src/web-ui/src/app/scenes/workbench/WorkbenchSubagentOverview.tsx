/**
 * WorkbenchSubagentOverview — 对话面板顶部的子代理汇总条。
 *
 * 为什么需要它：子代理的内联卡只能落在「派发那一刻」的消息位置，任务一长就
 * 被推到几千像素以外；用户要回答「这个任务现在有几个子代理、谁还在跑、跑多久」
 * 只能翻消息流。这里把同一父会话下的子代理收成一条常驻摘要；点某一行就
 * **滚回那张卡并就地展开**（不离开对话、不开中区标签）。
 *
 * 数据仍来自既有投影（`children` / `subagentCatalog` / `subagentTiming`），不新增协议。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown } from 'lucide-react';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { formatSubagentDuration } from './subagentTools';
import { focusSubagentCard } from './subagentFocus';
import './WorkbenchSubagentOverview.scss';

interface OverviewRow {
  id: string;
  label: string;
  preset: string | null;
  running: boolean;
  abnormal: boolean;
  durationMs: number;
}

export interface WorkbenchSubagentOverviewProps {
  parentSessionId: string;
}

export const WorkbenchSubagentOverview: React.FC<WorkbenchSubagentOverviewProps> = ({
  parentSessionId,
}) => {
  const { t } = useTranslation('common');
  const children = useWorkbenchTaskStore(s => s.children[parentSessionId]);
  const catalog = useWorkbenchTaskStore(s => s.subagentCatalog[parentSessionId]);
  const timing = useWorkbenchTaskStore(s => s.subagentTiming);

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const rows = useMemo<OverviewRow[]>(() => {
    const map = new Map<string, OverviewRow>();
    for (const meta of catalog ?? []) {
      map.set(meta.id, {
        id: meta.id,
        label: meta.label ?? '',
        preset: null,
        running: false,
        abnormal: false,
        durationMs: 0,
      });
    }
    for (const child of children ?? []) {
      const existing = map.get(child.sessionId);
      const item: OverviewRow = existing ?? {
        id: child.sessionId,
        label: '',
        preset: null,
        running: false,
        abnormal: false,
        durationMs: 0,
      };
      item.label = item.label || child.title || '';
      item.preset = child.preset ?? item.preset;
      item.running = child.running;
      map.set(child.sessionId, item);
    }
    const list = [...map.values()].map(item => {
      const clock = timing[item.id];
      const activeMs = clock?.active ? Math.max(0, now - clock.active.since) : 0;
      return {
        ...item,
        durationMs: (clock?.settledMs ?? 0) + activeMs,
        abnormal: !item.running && clock?.lastTurnCompleted === false,
      };
    });
    // 运行中优先，其次按耗时长的在前（派发早的先看到）
    return list.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.durationMs - a.durationMs;
    });
  }, [catalog, children, timing, now]);

  const runningCount = rows.filter(row => row.running).length;

  /** 有运行中的子代理时每秒推进耗时。 */
  useEffect(() => {
    if (runningCount === 0) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runningCount]);

  if (rows.length === 0) return null;

  return (
    <section className={`ai00-x-wb-subagent-overview${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ai00-x-wb-subagent-overview__head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Bot size={12} aria-hidden="true" className="ai00-x-wb-subagent-overview__icon" />
        <span className="ai00-x-wb-subagent-overview__count">
          {t('nav.workbenchWindow.subagentOverview', { count: rows.length })}
        </span>
        {runningCount > 0 && (
          <span className="ai00-x-wb-subagent-overview__running">
            {t('nav.workbenchWindow.subagentOverviewRunning', { count: runningCount })}
          </span>
        )}
        <ChevronDown
          size={12}
          aria-hidden="true"
          className="ai00-x-wb-subagent-overview__chevron"
        />
      </button>
      {open && (
        <ul className="ai00-x-wb-subagent-overview__list">
          {rows.map(row => (
            <li key={row.id}>
              <button
                type="button"
                className={`ai00-x-wb-subagent-overview__row${row.running ? ' is-running' : ''}`}
                title={t('nav.workbenchWindow.subagentLocate')}
                onClick={() => focusSubagentCard(row.id)}
              >
                <span className="ai00-x-wb-subagent-overview__dot" aria-hidden="true" />
                <span className="ai00-x-wb-subagent-overview__label" title={row.label || row.id}>
                  {row.label || row.id.slice(0, 8)}
                </span>
                <span className="ai00-x-wb-subagent-overview__state">
                  {row.running
                    ? t('nav.workbenchWindow.subagentRunning')
                    : row.abnormal
                      ? t('nav.workbenchWindow.subagentAbnormal')
                      : t('nav.workbenchWindow.subagentDone')}
                  {row.durationMs > 0 && ` · ${formatSubagentDuration(row.durationMs)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

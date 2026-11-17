/**
 * AutomationsScene — 自动化工作台。
 *
 * 规则真源在引擎（`dsh-schedule` 的 `schedule/*` Remote），本页只做外壳：
 * 列表、编辑、启停、立即运行、投递历史。
 *
 * 每次触发用 `target.kind='new'`：新建会话、新上下文（对应 SuperAgent 的
 * Worker 上下文隔离）；cwd 取项目目录或宿主创建的自动化专属目录，
 * preset 固定 `workbench`，产物仍是普通任务卡，走同一 loop。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  scheduleAPI,
  type ScheduleEntry,
  type ScheduleTiming,
} from '@/infrastructure/api/service-api/ScheduleAPI';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { relativeTime } from '../tasks/display';
import './AutomationsScene.scss';

/** 自动化工作台在 rail 中的保留 id。 */
export const AUTOMATIONS_SCENE_ID = '@automations';

type Frequency = 'daily' | 'weekly' | 'every';

interface EditorState {
  id: string | null;
  title: string;
  prompt: string;
  projectId: string | null;
  frequency: Frequency;
  time: string;
  weekdays: number[];
  hours: number;
  active: boolean;
  updatedAt?: string;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  title: '',
  prompt: '',
  projectId: null,
  frequency: 'daily',
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5],
  hours: 6,
  active: true,
};

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 引擎返回条目 → 编辑器状态。 */
function toEditor(entry: ScheduleEntry): EditorState {
  const base = { ...EMPTY_EDITOR, id: entry.id, title: entry.title, prompt: entry.prompt, active: entry.status === 'active', updatedAt: entry.updatedAt };
  if (entry.kind === 'weekly') {
    return {
      ...base,
      frequency: 'weekly',
      time: (entry.time ?? '09:00:00').slice(0, 5),
      weekdays: entry.weekdays?.length ? entry.weekdays : [1],
    };
  }
  if (entry.kind === 'every') {
    return { ...base, frequency: 'every', hours: Math.max(1, Math.round((entry.everySeconds ?? 3600) / 3600)) };
  }
  return { ...base, frequency: 'daily', time: (entry.time ?? '09:00:00').slice(0, 5) };
}

/** 编辑器状态 → 引擎 timing；every 走小时换算（≥1 分钟由引擎兜底）。 */
function toTiming(editor: EditorState): ScheduleTiming {
  const zone = localZone();
  if (editor.frequency === 'weekly') {
    return {
      kind: 'weekly',
      weekly: { time: `${editor.time}:00`, time_zone: zone, weekdays: editor.weekdays },
    };
  }
  if (editor.frequency === 'every') {
    return { kind: 'every', every_seconds: Math.max(60, Math.round(editor.hours) * 3600) };
  }
  return { kind: 'daily', daily: { time: `${editor.time}:00`, time_zone: zone } };
}

/** 列表行频率摘要。 */
function describeFrequency(entry: ScheduleEntry): string {
  if (entry.kind === 'daily') return `每天 ${(entry.time ?? '').slice(0, 5)}`;
  if (entry.kind === 'weekly') {
    const days = (entry.weekdays ?? []).join('/');
    return `每周 ${days} ${(entry.time ?? '').slice(0, 5)}`;
  }
  if (entry.kind === 'every') {
    const secs = entry.everySeconds ?? 3600;
    return secs % 3600 === 0 ? `每 ${secs / 3600} 小时` : `每 ${Math.round(secs / 60)} 分钟`;
  }
  if (entry.kind === 'cron') return `cron ${entry.expression ?? ''}`;
  if (entry.kind === 'after' || entry.kind === 'at') {
    return `${new Date(entry.scheduledAt).toLocaleString()} 一次性`;
  }
  if (entry.kind === 'rrule') return '自定义规则';
  return entry.kind;
}

export const AutomationsScene: React.FC = () => {
  const { t } = useI18n('common');
  const loaded = useTodoStore((s) => s.loaded);
  const load = useTodoStore((s) => s.load);
  const projects = useTodoStore((s) => s.data.projects);
  const automations = useTodoStore((s) => s.data.automations);
  const linkAutomation = useTodoStore((s) => s.linkAutomation);
  const unlinkAutomation = useTodoStore((s) => s.unlinkAutomation);

  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const items = await scheduleAPI.catalog();
      setEntries(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /** 项目归属：本地映射优先（引擎条目只带 cwd）。 */
  const projectOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const link of automations) map.set(link.scheduleId, link.projectId);
    return map;
  }, [automations]);

  const startNew = useCallback((): void => {
    setError(null);
    setEditor(EMPTY_EDITOR);
  }, []);

  const selectEntry = useCallback((entry: ScheduleEntry): void => {
    setError(null);
    setEditor(toEditor(entry));
  }, []);

  /** 默认工作区的自动化：宿主建一个专属目录，避免与手工任务目录混用。 */
  const prepareAutomationDir = useCallback(
    async (scheduleId: string): Promise<string> => {
      const ctx = await invoke<{ projectRoot: string }>('workbench_prepare_project', {
        workbenchId: 'tasks',
        dataDirName: 'automations',
        workbenchTitle: t('nav.workbenchWindow.automations.title'),
        agentInstructions: null,
        projectId: `a-${scheduleId.replace(/[^a-zA-Z0-9-]/g, '-')}`,
        projectTitle: t('nav.workbenchWindow.automations.title'),
      });
      return ctx.projectRoot;
    },
    [t],
  );

  const save = useCallback(async (): Promise<void> => {
    if (busy) return;
    const title = editor.title.trim();
    const prompt = editor.prompt.trim();
    if (!title || !prompt) {
      setError(t('nav.workbenchWindow.automations.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const timing = toTiming(editor);
      if (editor.id) {
        await scheduleAPI.update(editor.id, {
          title,
          prompt,
          timing,
          active: editor.active,
        });
        if (editor.projectId !== (projectOf.get(editor.id) ?? null)) {
          linkAutomation({ scheduleId: editor.id, projectId: editor.projectId });
        }
      } else {
        const created = await scheduleAPI.create({
          title,
          prompt,
          timing,
          target: { kind: 'new_once' },
        });
        const project = projects.find((p) => p.id === editor.projectId) ?? null;
        const cwd = project ? project.dir : await prepareAutomationDir(created.id);
        await scheduleAPI.update(created.id, {
          target: { kind: 'new', create: { cwd, agentPreset: 'workbench' } },
          active: editor.active,
        });
        linkAutomation({ scheduleId: created.id, projectId: editor.projectId });
        setEditor((prev) => ({ ...prev, id: created.id }));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, editor, linkAutomation, prepareAutomationDir, projectOf, projects, refresh, t]);

  const remove = useCallback(
    async (entry: ScheduleEntry): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await scheduleAPI.remove(entry.id);
        unlinkAutomation(entry.id);
        setEditor(EMPTY_EDITOR);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh, unlinkAutomation],
  );

  const runNow = useCallback(
    async (entry: ScheduleEntry): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await scheduleAPI.run(entry.id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const selectedEntry = entries.find((e) => e.id === editor.id) ?? null;

  return (
    <div className="ai00-x-automations-scene">
      <aside className="ai00-x-automations-scene__list">
        <div className="ai00-x-automations-scene__list-head">
          <span className="ai00-x-automations-scene__list-title">
            {t('nav.workbenchWindow.automations.title')}
          </span>
          <button
            type="button"
            className="ai00-x-automations-scene__icon-button"
            onClick={startNew}
            title={t('nav.workbenchWindow.automations.new')}
            aria-label={t('nav.workbenchWindow.automations.new')}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="ai00-x-automations-scene__items">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`ai00-x-automations-scene__item${
                entry.id === editor.id ? ' is-active' : ''
              }`}
              aria-current={entry.id === editor.id ? 'true' : undefined}
              onClick={() => selectEntry(entry)}
            >
              <span
                className={`ai00-x-automations-scene__dot is-${entry.status}${
                  entry.executionActive ? ' is-running' : ''
                }`}
                aria-hidden="true"
              />
              <span className="ai00-x-automations-scene__item-body">
                <span className="ai00-x-automations-scene__item-title">{entry.title}</span>
                <span className="ai00-x-automations-scene__item-meta">
                  {describeFrequency(entry)}
                </span>
              </span>
            </button>
          ))}
          {!loading && entries.length === 0 && (
            <p className="ai00-x-automations-scene__empty">
              {t('nav.workbenchWindow.automations.empty')}
            </p>
          )}
        </div>
      </aside>

      <main className="ai00-x-automations-scene__main">
        <header className="ai00-x-automations-scene__head">
          <CalendarClock size={15} />
          <h1 className="ai00-x-automations-scene__title">
            {editor.id
              ? t('nav.workbenchWindow.automations.editTitle')
              : t('nav.workbenchWindow.automations.newTitle')}
          </h1>
        </header>

        <div className="ai00-x-automations-scene__body">
          {error && (
            <p className="ai00-x-automations-scene__error" role="alert">
              {error}
            </p>
          )}

          <label className="ai00-x-automations-scene__field">
            <span>{t('nav.workbenchWindow.automations.name')}</span>
            <input
              value={editor.title}
              onChange={(e) => setEditor((prev) => ({ ...prev, title: e.target.value }))}
              placeholder={t('nav.workbenchWindow.automations.namePlaceholder')}
              maxLength={120}
            />
          </label>

          <label className="ai00-x-automations-scene__field">
            <span>{t('nav.workbenchWindow.automations.prompt')}</span>
            <textarea
              value={editor.prompt}
              onChange={(e) => setEditor((prev) => ({ ...prev, prompt: e.target.value }))}
              placeholder={t('nav.workbenchWindow.automations.promptPlaceholder')}
              rows={5}
            />
          </label>

          <label className="ai00-x-automations-scene__field">
            <span>{t('nav.workbenchWindow.automations.target')}</span>
            <select
              value={editor.projectId ?? ''}
              onChange={(e) =>
                setEditor((prev) => ({ ...prev, projectId: e.target.value || null }))
              }
            >
              <option value="">{t('nav.workbenchWindow.automations.defaultWorkspace')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <div className="ai00-x-automations-scene__field">
            <span>{t('nav.workbenchWindow.automations.frequency')}</span>
            <div className="ai00-x-automations-scene__row">
              <select
                value={editor.frequency}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, frequency: e.target.value as Frequency }))
                }
              >
                <option value="daily">{t('nav.workbenchWindow.automations.daily')}</option>
                <option value="weekly">{t('nav.workbenchWindow.automations.weekly')}</option>
                <option value="every">{t('nav.workbenchWindow.automations.every')}</option>
              </select>
              {editor.frequency === 'every' ? (
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={editor.hours}
                  onChange={(e) =>
                    setEditor((prev) => ({ ...prev, hours: Number(e.target.value) || 1 }))
                  }
                />
              ) : (
                <input
                  type="time"
                  value={editor.time}
                  onChange={(e) => setEditor((prev) => ({ ...prev, time: e.target.value }))}
                />
              )}
            </div>
            {editor.frequency === 'weekly' && (
              <div className="ai00-x-automations-scene__weekdays">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const on = editor.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`ai00-x-automations-scene__weekday${on ? ' is-on' : ''}`}
                      onClick={() =>
                        setEditor((prev) => ({
                          ...prev,
                          weekdays: on
                            ? prev.weekdays.filter((d) => d !== day)
                            : [...prev.weekdays, day].sort((a, b) => a - b),
                        }))
                      }
                    >
                      {t(`nav.workbenchWindow.automations.weekday.${day}`)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <label className="ai00-x-automations-scene__switch">
            <input
              type="checkbox"
              checked={editor.active}
              onChange={(e) => setEditor((prev) => ({ ...prev, active: e.target.checked }))}
            />
            <span>{t('nav.workbenchWindow.automations.enabled')}</span>
          </label>

          <div className="ai00-x-automations-scene__actions">
            {editor.id && (
              <>
                <button
                  type="button"
                  className="ai00-x-automations-scene__button"
                  disabled={busy || !selectedEntry}
                  onClick={() => selectedEntry && void runNow(selectedEntry)}
                >
                  <Play size={12} />
                  {t('nav.workbenchWindow.automations.runNow')}
                </button>
                <button
                  type="button"
                  className="ai00-x-automations-scene__button is-danger"
                  disabled={busy || !selectedEntry}
                  onClick={() => selectedEntry && void remove(selectedEntry)}
                >
                  <Trash2 size={12} />
                  {t('nav.workbenchWindow.automations.delete')}
                </button>
              </>
            )}
            <button
              type="button"
              className="ai00-x-automations-scene__button is-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy
                ? t('nav.workbenchWindow.automations.saving')
                : t('nav.workbenchWindow.automations.save')}
            </button>
          </div>

          {selectedEntry && (
            <section className="ai00-x-automations-scene__status">
              <h2>{t('nav.workbenchWindow.automations.statusTitle')}</h2>
              <dl>
                <div>
                  <dt>{t('nav.workbenchWindow.automations.nextRun')}</dt>
                  <dd>
                    {selectedEntry.status === 'active'
                      ? new Date(selectedEntry.scheduledAt).toLocaleString()
                      : t(`nav.workbenchWindow.automations.state.${selectedEntry.status}`)}
                  </dd>
                </div>
                <div>
                  <dt>{t('nav.workbenchWindow.automations.lastRun')}</dt>
                  <dd>
                    {selectedEntry.lastDelivery
                      ? `${new Date(selectedEntry.lastDelivery.deliveredAt).toLocaleString()} · ${relativeTime(
                          Date.parse(selectedEntry.lastDelivery.deliveredAt),
                        )}`
                      : t('nav.workbenchWindow.automations.neverRun')}
                  </dd>
                </div>
                <div>
                  <dt>{t('nav.workbenchWindow.automations.stateLabel')}</dt>
                  <dd>{t(`nav.workbenchWindow.automations.state.${selectedEntry.status}`)}</dd>
                </div>
              </dl>
              <p className="ai00-x-automations-scene__hint">
                {t('nav.workbenchWindow.automations.runtimeHint')}
              </p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
};

export default AutomationsScene;

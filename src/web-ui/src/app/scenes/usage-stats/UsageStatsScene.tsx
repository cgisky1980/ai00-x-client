/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * UsageStatsScene — software usage statistics dashboard.
 *
 * 5 tabs (Patina-inspired):
 *   1. Today       — Patina-style dashboard (focus ring + hourly + top apps)
 *   2. History     — Patina-style history (date navigator + horizontal timeline +
 *                    day summary + day distribution + hourly chart)
 *   3. Data        — Patina-style data view (range selector + AreaChart + heatmap + top apps)
 *   4. Apps        — app_rules management (rename / categorize / color / exclude)
 *   5. Settings    — placeholder (Phase 5: backup/restore)
 *
 * Today, History, and Data use recharts + framer-motion (Patina port).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Clock,
  Calendar,
  Boxes,
  Settings as SettingsIcon,
  Loader2,
  AlertTriangle,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { createLogger } from '@/shared/utils/logger';
import { usageStatsApi } from '@/infrastructure/api/usageStatsApi';
import type { AppRule, Category } from '@/infrastructure/api/usageStatsApi';
import DashboardView from './DashboardView';
import HistoryView from './HistoryView';
import DataTrendsView from './DataTrendsView';
import './UsageStatsScene.scss';

const log = createLogger('UsageStatsScene');

type TabId = 'today' | 'history' | 'data' | 'apps' | 'settings';

const TABS: { id: TabId; icon: typeof BarChart3 }[] = [
  { id: 'today', icon: Clock },
  { id: 'history', icon: Calendar },
  { id: 'data', icon: BarChart3 },
  { id: 'apps', icon: Boxes },
  { id: 'settings', icon: SettingsIcon },
];

const UsageStatsScene: React.FC = () => {
  const { t } = useI18n('common');
  const [activeTab, setActiveTab] = useState<TabId>('today');

  return (
    <div className="usage-stats-scene">
      <header className="usage-stats-scene__header">
        <h2 className="usage-stats-scene__title">
          <BarChart3 size={20} />
          <span>{t('usageStats.title', { defaultValue: 'Usage Statistics' })}</span>
        </h2>
        <nav className="usage-stats-scene__tabs">
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={[
                'usage-stats-scene__tab',
                activeTab === id && 'usage-stats-scene__tab--active',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={16} />
              <span>{t(`usageStats.tabs.${id}`, { defaultValue: id })}</span>
            </button>
          ))}
        </nav>
      </header>

      <div className="usage-stats-scene__body">
        {activeTab === 'today' && <DashboardView />}
        {activeTab === 'history' && <HistoryView />}
        {activeTab === 'data' && <DataTrendsView />}
        {activeTab === 'apps' && <AppsView />}
        {activeTab === 'settings' && <SettingsView />}
      </div>
    </div>
  );
};

// ── Shared small components ────────────────────────────────────────────

const Loading: React.FC = () => (
  <div className="usage-stats-scene__loading">
    <Loader2 size={24} className="usage-stats-scene__spinner" />
  </div>
);

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div className="usage-stats-scene__error">
    <AlertTriangle size={18} />
    <span>{message}</span>
  </div>
);

/** App icon with colored-letter fallback when no icon is available. */
const AppIcon: React.FC<{
  icon: string | null;
  exePath: string;
  size?: number;
}> = ({ icon, exePath, size = 20 }) => {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        className="app-icon"
        style={{ width: size, height: size }}
        draggable={false}
      />
    );
  }
  const color = defaultColorForApp(exePath);
  const letter = (exePath.split(/[\\/]/).pop() ?? '?').charAt(0).toUpperCase();
  return (
    <div
      className="app-icon app-icon--fallback"
      style={{ width: size, height: size, backgroundColor: color }}
    >
      {letter}
    </div>
  );
};

// ── 3. Trends View: see DataTrendsView.tsx (Patina-style port) ────────

// ── 4. Apps Management View ────────────────────────────────────────────

const AppsView: React.FC = () => {
  const { t } = useI18n('common');
  const [rules, setRules] = useState<AppRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AppRule | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        usageStatsApi.listAppRules(),
        usageStatsApi.listCategories(),
      ]);
      setRules(r);
      setCategories(c);
    } catch (e) {
      log.error('Failed to load app rules', e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const startEdit = (rule: AppRule) => {
    setEditingPath(rule.exe_path);
    setEditForm({ ...rule });
  };

  const cancelEdit = () => {
    setEditingPath(null);
    setEditForm(null);
  };

  const saveEdit = async () => {
    if (!editForm) return;
    try {
      await usageStatsApi.updateAppRule(editForm);
      cancelEdit();
      await fetch();
    } catch (e) {
      log.error('Failed to update app rule', e);
      setError(String(e));
    }
  };

  const deleteRule = async (exePath: string) => {
    if (!confirm(t('usageStats.confirmDelete', { defaultValue: 'Delete this app rule?' }))) return;
    try {
      await usageStatsApi.deleteAppRule(exePath);
      await fetch();
    } catch (e) {
      log.error('Failed to delete app rule', e);
      setError(String(e));
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="usage-stats-view apps-view">
      {rules.length === 0 ? (
        <p className="apps-view__empty">
          {t('usageStats.noAppsYet', {
            defaultValue: 'No apps tracked yet. Use the app for a while and come back.',
          })}
        </p>
      ) : (
        <table className="apps-view__table">
          <thead>
            <tr>
              <th></th>
              <th>{t('usageStats.processName', { defaultValue: 'Process' })}</th>
              <th>{t('usageStats.displayName', { defaultValue: 'Display Name' })}</th>
              <th>{t('usageStats.category', { defaultValue: 'Category' })}</th>
              <th>{t('usageStats.color', { defaultValue: 'Color' })}</th>
              <th>{t('usageStats.exclude', { defaultValue: 'Exclude' })}</th>
              <th>{t('usageStats.captureTitle', { defaultValue: 'Title' })}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.exe_path}>
                {editingPath === rule.exe_path && editForm ? (
                  <>
                    <td><AppIcon icon={rule.icon} exePath={rule.exe_path} size={20} /></td>
                    <td title={rule.exe_path}>{rule.process_name}</td>
                    <td>
                      <input
                        type="text"
                        value={editForm.display_name ?? ''}
                        onChange={(e) =>
                          setEditForm({ ...editForm, display_name: e.target.value || null })
                        }
                        placeholder={rule.process_name}
                      />
                    </td>
                    <td>
                      <select
                        value={editForm.category_id ?? ''}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            category_id: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">—</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="color"
                        value={editForm.color ?? '#4a9eff'}
                        onChange={(e) =>
                          setEditForm({ ...editForm, color: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={editForm.exclude_from_stats}
                        onChange={(e) =>
                          setEditForm({ ...editForm, exclude_from_stats: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={editForm.capture_title}
                        onChange={(e) =>
                          setEditForm({ ...editForm, capture_title: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <div className="apps-view__row-actions">
                        <button type="button" className="apps-view__btn-save" onClick={saveEdit}>
                          <Check size={14} />
                        </button>
                        <button type="button" className="apps-view__btn-cancel" onClick={cancelEdit}>
                          <X size={14} />
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td><AppIcon icon={rule.icon} exePath={rule.exe_path} size={20} /></td>
                    <td title={rule.exe_path}>{rule.process_name}</td>
                    <td>{rule.display_name ?? '—'}</td>
                    <td>
                      {categories.find((c) => c.id === rule.category_id)?.name ?? '—'}
                    </td>
                    <td>
                      {rule.color ? (
                        <span
                          className="apps-view__color-chip"
                          style={{ backgroundColor: rule.color }}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{rule.exclude_from_stats ? '✓' : ''}</td>
                    <td>{rule.capture_title ? '✓' : ''}</td>
                    <td>
                      <div className="apps-view__row-actions">
                        <button type="button" onClick={() => startEdit(rule)} title={t('usageStats.edit')}>
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRule(rule.exe_path)}
                          title={t('usageStats.delete')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="apps-view__categories">
        <h3>{t('usageStats.categories', { defaultValue: 'Categories' })}</h3>
        <CategoryManager categories={categories} onChange={fetch} />
      </div>
    </div>
  );
};

const CategoryManager: React.FC<{
  categories: Category[];
  onChange: () => void;
}> = ({ categories, onChange }) => {
  const { t } = useI18n('common');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#4a9eff');

  const create = async () => {
    if (!newName.trim()) return;
    try {
      await usageStatsApi.createCategory(newName.trim(), newColor);
      setNewName('');
      onChange();
    } catch (e) {
      log.error('Failed to create category', e);
    }
  };

  const del = async (id: number) => {
    if (!confirm(t('usageStats.deleteCategoryConfirm'))) return;
    try {
      await usageStatsApi.deleteCategory(id);
      onChange();
    } catch (e) {
      log.error('Failed to delete category', e);
    }
  };

  return (
    <div className="category-manager">
      <ul className="category-manager__list">
        {categories.map((c) => (
          <li key={c.id} className="category-manager__item">
            <span
              className="category-manager__color"
              style={{ backgroundColor: c.color ?? '#888' }}
            />
            <span>{c.name}</span>
            <button type="button" onClick={() => del(c.id)}>
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      <div className="category-manager__form">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('usageStats.newCategoryName')}
        />
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
        />
        <button type="button" onClick={create}>
          {t('usageStats.add')}
        </button>
      </div>
    </div>
  );
};

// ── 5. Settings View (placeholder) ─────────────────────────────────────

const SettingsView: React.FC = () => {
  const { t } = useI18n('common');
  return (
    <div className="usage-stats-view settings-view">
      <p className="settings-view__hint">
        {t('usageStats.settingsHint', {
          defaultValue:
            'Usage statistics are stored locally in usage_stats.db. Backup, restore, and reporter (HTTP upload) options will land in a future phase.',
        })}
      </p>
    </div>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Deterministic fallback color for apps without a configured color. */
function defaultColorForApp(exePath: string): string {
  let hash = 0;
  for (let i = 0; i < exePath.length; i++) {
    hash = (hash * 31 + exePath.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

export default UsageStatsScene;

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Edit2, Trash2, Eye, EyeOff, Brain, Sparkles } from 'lucide-react';
import { IconButton, Button, Modal, Input, Textarea, Select } from '@/component-library';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageSection,
  ConfigPageRow,
  ConfigCollectionItem,
} from './common';
import {
  getAllMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  toggleMemory,
  type AIMemory,
  type MemoryType,
} from '@/infrastructure/api/aiMemoryApi';
import { insightsApi, type InsightsReportMeta } from '@/infrastructure/api/insightsApi';
import { useNotification } from '@/shared/notification-system';
import { i18nService } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import './MemoryConfig.scss';

const log = createLogger('MemoryConfig');

const memoryTypeMap: Record<MemoryType, { labelKey: string; color: string }> = {
  tech_preference: { labelKey: 'memoryTypes.tech_preference', color: '#60a5fa' },
  project_context: { labelKey: 'memoryTypes.project_context', color: '#a78bfa' },
  user_habit: { labelKey: 'memoryTypes.user_habit', color: '#34d399' },
  code_pattern: { labelKey: 'memoryTypes.code_pattern', color: '#fbbf24' },
  decision: { labelKey: 'memoryTypes.decision', color: '#f87171' },
  other: { labelKey: 'memoryTypes.other', color: '#94a3b8' },
};

interface PanelProps {
  t: (key: string, options?: Record<string, unknown>) => string;
}

interface MemoryEditDialogProps {
  memory: AIMemory | null;
  onClose: () => void;
  onSave: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const MemoryEditDialog: React.FC<MemoryEditDialogProps> = ({ memory, onClose, onSave, t }) => {
  const notification = useNotification();
  const [title, setTitle] = useState(memory?.title || '');
  const [content, setContent] = useState(memory?.content || '');
  const [memoryType, setMemoryType] = useState<MemoryType>(memory?.type || 'other');
  const [importance, setImportance] = useState(memory?.importance || 3);
  const [tags, setTags] = useState(memory?.tags?.join(', ') || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) {
      notification.error(t('messages.validationError'));
      return;
    }
    try {
      setSaving(true);
      const tagsArray = tags.split(',').map((s) => s.trim()).filter(Boolean);
      if (memory) {
        await updateMemory({
          id: memory.id,
          title,
          content,
          type: memoryType,
          importance,
          tags: tagsArray,
          enabled: memory.enabled,
        });
        notification.success(t('messages.updateSuccess'));
      } else {
        await addMemory({ title, content, type: memoryType, importance, tags: tagsArray });
        notification.success(t('messages.createSuccess'));
      }
      onSave();
      onClose();
    } catch (error) {
      notification.error(t('messages.saveFailed', { error: String(error) }));
    } finally {
      setSaving(false);
    }
  };

  const typeOptions = Object.entries(memoryTypeMap).map(([key, info]) => ({
    value: key,
    label: t(info.labelKey),
  }));

  return (
    <Modal isOpen onClose={onClose} title={memory ? t('dialog.titleEdit') : t('dialog.titleCreate')} size="medium">
      <div className="ai00-x-memory-config__dialog-body">
        <Input label={t('dialog.fields.title')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dialog.fields.titlePlaceholder')} />
        <Select label={t('dialog.fields.type')} options={typeOptions} value={memoryType} onChange={(val) => setMemoryType(val as MemoryType)} />
        <div className="ai00-x-memory-config__form-group">
          <label>{t('dialog.fields.importance')} ({importance}/5)</label>
          <input type="range" min={1} max={5} value={importance} onChange={(e) => setImportance(Number(e.target.value))} />
        </div>
        <Textarea label={t('dialog.fields.content')} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('dialog.fields.contentPlaceholder')} rows={6} />
        <Input label={t('dialog.fields.tags')} value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('dialog.fields.tagsPlaceholder')} />
      </div>
      <div className="ai00-x-memory-config__dialog-footer">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t('dialog.actions.cancel')}</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving} isLoading={saving}>
          {saving ? t('dialog.actions.saving') : t('dialog.actions.save')}
        </Button>
      </div>
    </Modal>
  );
};

function MemoryPanel({ t }: PanelProps) {
  const { error: notifyError, success: notifySuccess } = useNotification();
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<string>>(new Set());
  const [memories, setMemories] = useState<AIMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<AIMemory | null>(null);

  const loadMemories = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getAllMemories();
      setMemories(data);
    } catch (error) {
      notifyError(t('messages.loadFailed', { error: String(error) }));
    } finally {
      setLoading(false);
    }
  }, [notifyError, t]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const sortedMemories = [...memories].sort((a, b) => b.importance - a.importance);

  const toggleMemoryExpanded = (memoryId: string) => {
    setExpandedMemoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(memoryId)) next.delete(memoryId);
      else next.add(memoryId);
      return next;
    });
  };

  const handleDelete = async (id: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (isDeleting) return;
    if (!(await window.confirm(t('messages.confirmDelete')))) return;
    try {
      setIsDeleting(true);
      await deleteMemory(id);
      notifySuccess(t('messages.deleteSuccess'));
      await loadMemories();
    } catch (error) {
      log.error('Failed to delete memory', { memoryId: id, error });
      notifyError(t('messages.deleteFailed', { error: String(error) }));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggle = async (id: string) => {
    try {
      await toggleMemory(id);
      loadMemories();
    } catch (error) {
      notifyError(t('messages.toggleFailed', { error: String(error) }));
    }
  };

  const handleAdd = () => {
    setEditingMemory(null);
    setIsAddDialogOpen(true);
  };

  const handleEdit = (memory: AIMemory, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingMemory(memory);
    setIsAddDialogOpen(true);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return t('date.today');
    if (diffDays === 1) return t('date.yesterday');
    if (diffDays < 7) return t('date.daysAgo', { days: diffDays });
    return i18nService.formatDate(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  };

  const renderMemoryBadge = (memory: AIMemory) => {
    const typeInfo = memoryTypeMap[memory.type];
    return (
      <>
        <span className="ai00-x-memory-config__badge--type" style={{ background: `${typeInfo.color}20`, color: typeInfo.color }}>
          {t(typeInfo.labelKey)}
        </span>
        <span className="ai00-x-collection-item__badge">{formatDate(memory.created_at)}</span>
      </>
    );
  };

  const renderMemoryControl = (memory: AIMemory) => (
    <>
      <IconButton tooltip={memory.enabled ? t('actions.disable') : t('actions.enable')} onClick={() => handleToggle(memory.id)} size="small" variant="ghost">
        {memory.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </IconButton>
      <IconButton tooltip={t('actions.edit')} onClick={(e) => handleEdit(memory, e)} size="small" variant="ghost">
        <Edit2 size={14} />
      </IconButton>
      <IconButton tooltip={t('actions.delete')} onClick={(e) => handleDelete(memory.id, e)} size="small" variant="danger" disabled={isDeleting}>
        <Trash2 size={14} />
      </IconButton>
    </>
  );

  const renderMemoryDetails = (memory: AIMemory) => (
    <>
      <div className="ai00-x-collection-details__field">
        <div className="ai00-x-collection-details__label">{t('list.item.contentLabel')}</div>
        {memory.content}
      </div>
      <div className="ai00-x-collection-details__meta">
        <span>{t('list.item.sourcePrefix')}{memory.source}</span>
        {' · '}
        <span>{t('list.item.createdPrefix')}{i18nService.formatDate(new Date(memory.created_at))}</span>
      </div>
    </>
  );

  const addButton = (
    <IconButton variant="ghost" size="small" onClick={handleAdd} tooltip={t('toolbar.addTooltip')}>
      <Plus size={16} />
    </IconButton>
  );

  return (
    <ConfigPageSection
      title={t('section.memoryList.title')}
      description={t('section.memoryList.description')}
      extra={addButton}
    >
      {loading && (
        <div className="ai00-x-collection-empty"><p>{t('list.loading')}</p></div>
      )}
      {!loading && sortedMemories.length === 0 && (
        <div className="ai00-x-collection-empty">
          <p>{t('list.empty.title')}</p>
          <Button variant="dashed" size="small" onClick={handleAdd}>
            <Plus size={14} /> {t('toolbar.addTooltip')}
          </Button>
        </div>
      )}
      {!loading && sortedMemories.map((memory) => (
        <ConfigCollectionItem
          key={memory.id}
          label={memory.title}
          badge={renderMemoryBadge(memory)}
          control={renderMemoryControl(memory)}
          details={renderMemoryDetails(memory)}
          disabled={!memory.enabled}
          expanded={expandedMemoryIds.has(memory.id)}
          onToggle={() => toggleMemoryExpanded(memory.id)}
        />
      ))}

      {isAddDialogOpen && (
        <MemoryEditDialog
          memory={editingMemory}
          onClose={() => setIsAddDialogOpen(false)}
          onSave={loadMemories}
          t={t}
        />
      )}
    </ConfigPageSection>
  );
}

function InsightsPanel({ t }: PanelProps) {
  const [reportMetas, setReportMetas] = useState<InsightsReportMeta[]>([]);
  const [loading, setLoading] = useState(false);

  const loadReports = useCallback(async () => {
    try {
      setLoading(true);
      const metas = await insightsApi.getLatestInsights();
      setReportMetas(metas);
    } catch {
      setReportMetas([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const formatDate = (timestamp: number) => {
    return i18nService.formatDate(new Date(timestamp * 1000), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  return (
    <ConfigPageSection
      title={t('section.insights.title')}
      description={t('section.insights.description')}
    >
      <ConfigPageRow label={t('section.insights.recentReports')} align="center">
        <span className="ai00-x-memory-config__count">
          {loading ? '...' : reportMetas.length}
        </span>
      </ConfigPageRow>
      {reportMetas.length > 0 && (
        <div className="ai00-x-memory-config__report-list">
          {reportMetas.slice(0, 3).map((meta) => (
            <div key={meta.path} className="ai00-x-memory-config__report-item">
              <Sparkles size={12} />
              <span className="ai00-x-memory-config__report-date">{formatDate(meta.generated_at)}</span>
              <span className="ai00-x-memory-config__report-meta">
                {meta.analyzed_sessions} sessions · {meta.total_hours.toFixed(1)}h
              </span>
            </div>
          ))}
        </div>
      )}
    </ConfigPageSection>
  );
}

function KnowledgeGraphPlaceholder({ t }: PanelProps) {
  return (
    <ConfigPageSection
      title={t('section.knowledgeGraph.title')}
      description={t('section.knowledgeGraph.description')}
    >
      <div className="ai00-x-memory-config__placeholder">
        <Brain size={24} />
        <p>{t('section.knowledgeGraph.comingSoon')}</p>
      </div>
    </ConfigPageSection>
  );
}

const MemoryConfig: React.FC = () => {
  const { t } = useTranslation('settings/memory');

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('title', { defaultValue: 'Memory' })}
        subtitle={t('subtitle', { defaultValue: 'Knowledge graph and memory management' })}
      />
      <ConfigPageContent>
        <MemoryPanel t={t} />
        <InsightsPanel t={t} />
        <KnowledgeGraphPlaceholder t={t} />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default MemoryConfig;

import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input, Textarea, Switch, Button } from '@/component-library';
import { SubagentAPI } from '@/infrastructure/api/service-api/SubagentAPI';
import type { SubagentLevel } from '@/infrastructure/api/service-api/SubagentAPI';
import { useNotification } from '@/shared/notification-system';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useAgentsStore } from '../agentsStore';
import '../AgentsView.scss';
import './CreateAgentPage.scss';

const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const CreateAgentPage: React.FC = () => {
  const { t } = useTranslation('scenes/agents');
  const { openHome, agentEditorMode, editingAgentId } = useAgentsStore();
  const notification = useNotification();
  const { hasWorkspace, workspacePath } = useCurrentWorkspace();

  const isEdit = agentEditorMode === 'edit' && Boolean(editingAgentId);

  const [level, setLevel] = useState<SubagentLevel>('user');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [readonly, setReadonly] = useState(true);
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    SubagentAPI.listAgentToolNames().then(setToolNames).catch(() => setToolNames([]));
  }, []);

  useEffect(() => {
    if (!hasWorkspace && level === 'project') {
      setLevel('user');
    }
  }, [hasWorkspace, level]);

  useEffect(() => {
    if (!isEdit || !editingAgentId) {
      setDetailLoading(false);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    (async () => {
      try {
        const d = await SubagentAPI.getSubagentDetail({
          subagentId: editingAgentId,
          workspacePath: workspacePath || undefined,
        });
        if (cancelled) return;
        setName(d.name);
        setDescription(d.description);
        setPrompt(d.prompt);
        setReadonly(d.readonly);
        setLevel(d.level);
        setSelectedTools(new Set(d.tools ?? []));
        setNameError(null);
      } catch (e) {
        if (cancelled) return;
        setDetailError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isEdit, editingAgentId, workspacePath]);

  const validateName = useCallback((v: string) => {
    if (!v.trim()) return t('agentsOverview.form.nameRequired', 'Name is required');
    if (!NAME_REGEX.test(v.trim())) return t('agentsOverview.form.nameFormat', 'Must start with a letter, followed by letters/numbers/underscores/hyphens');
    return null;
  }, [t]);

  const toggleTool = (tool: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) {
        next.delete(tool);
      } else {
        next.add(tool);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!isEdit) {
      const err = validateName(name);
      if (err) { setNameError(err); return; }
    }
    if (!description.trim()) { notification.error(t('agentsOverview.form.descRequired', 'Description is required')); return; }
    if (!prompt.trim()) { notification.error(t('agentsOverview.form.promptRequired', 'System prompt is required')); return; }
    if (level === 'project' && !workspacePath) {
      notification.error(t('agentsOverview.form.noWorkspace', 'Need to open a project first'));
      return;
    }
    if (isEdit && !editingAgentId) {
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && editingAgentId) {
        await SubagentAPI.updateSubagent({
          subagentId: editingAgentId,
          description: description.trim(),
          prompt: prompt.trim(),
          readonly,
          tools: selectedTools.size > 0 ? Array.from(selectedTools) : undefined,
          workspacePath: level === 'project' ? workspacePath : undefined,
        });
        notification.success(t('agentsOverview.form.updateSuccess', { name: name.trim() }));
      } else {
        await SubagentAPI.createSubagent({
          level,
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          readonly,
          tools: selectedTools.size > 0 ? Array.from(selectedTools) : undefined,
          workspacePath: level === 'project' ? workspacePath : undefined,
        });
        notification.success(t('agentsOverview.form.createSuccess', { name: name.trim() }));
      }
      openHome();
    } catch (err) {
      notification.error(
        (isEdit ? t('agentsOverview.form.updateFailed', 'Save failed: ') : t('agentsOverview.form.createFailed', 'Create failed: ')) +
        (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSubmitting(false);
    }
  };

  const formTitle = isEdit
    ? t('agentsOverview.form.titleEdit', 'Edit Sub-Agent')
    : t('agentsOverview.form.title', 'New Sub-Agent');
  const formSubtitle = isEdit
    ? t('agentsOverview.form.subtitleEdit', 'Edit description, prompt, tools and readonly settings. Name and level cannot be changed.')
    : t('agentsOverview.form.subtitle', 'Create a custom user-level or project-level Sub-Agent');
  const submitLabel = isEdit
    ? t('agentsOverview.form.save', 'Save')
    : t('agentsOverview.form.submit', 'Create');

  if (isEdit && detailLoading) {
    return (
      <div className="tv">
        <div className="tv__editor-bar">
          <button className="tv__back-btn" onClick={openHome} type="button">
            <ArrowLeft size={14} />
            <span>{t('agentsOverview.backToOverview', 'Back to Overview')}</span>
          </button>
        </div>
        <div className="th__list-body">
          <div className="th__list-inner">
            <p className="th__title-sub">{t('agentsOverview.form.loadingDetail', 'Loading...')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (isEdit && detailError) {
    return (
      <div className="tv">
        <div className="tv__editor-bar">
          <button className="tv__back-btn" onClick={openHome} type="button">
            <ArrowLeft size={14} />
            <span>{t('agentsOverview.backToOverview', 'Back to Overview')}</span>
          </button>
        </div>
        <div className="th__list-body">
          <div className="th__list-inner">
            <p className="th-create-panel__error">{detailError}</p>
            <Button variant="secondary" size="small" onClick={openHome}>{t('agentsOverview.form.cancel', 'Cancel')}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tv">
      <div className="tv__editor-bar">
        <button className="tv__back-btn" onClick={openHome} type="button">
          <ArrowLeft size={14} />
          <span>{t('agentsOverview.backToOverview', 'Back to Overview')}</span>
        </button>
      </div>

      <div className="th__list-body">
        <div className="th__list-inner">
          <div className="th-create-page__head">
            <h2 className="th__title">{formTitle}</h2>
            <p className="th__title-sub">{formSubtitle}</p>
          </div>

          <div className="th-create-page__form">
            <div className="th-create-panel__field">
              <label className="th-create-panel__label">{t('agentsOverview.form.name', 'Name')}</label>
              <Input
                value={name}
                onChange={(e) => { setName(e.target.value); setNameError(validateName(e.target.value)); }}
                onBlur={() => setNameError(validateName(name))}
                placeholder={t('agentsOverview.form.namePlaceholder', 'Start with a letter, may contain letters/numbers/underscores')}
                inputSize="small"
                error={!!nameError}
                disabled={isEdit}
              />
              {nameError && <span className="th-create-panel__error">{nameError}</span>}
            </div>

            <div className="th-create-panel__field">
              <label className="th-create-panel__label">{t('agentsOverview.form.description', 'Description')}</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('agentsOverview.form.descPlaceholder', 'Briefly describe the agent purpose')}
                inputSize="small"
              />
            </div>

            <div className="th-create-panel__field th-create-panel__field--row">
              <div className="th-create-panel__level-group">
                {(['user', 'project'] as SubagentLevel[]).map((lv) => {
                  const disabled = (lv === 'project' && !hasWorkspace) || isEdit;
                  return (
                    <button
                      key={lv}
                      type="button"
                      disabled={disabled}
                      className={`th-create-panel__level-btn${level === lv ? ' is-active' : ''}`}
                      onClick={() => setLevel(lv)}
                      title={disabled && !isEdit ? t('agentsOverview.form.noWorkspace', 'Need to open a project first') : undefined}
                    >
                      {lv === 'user' ? t('agentsOverview.filterUser', 'User Level') : t('agentsOverview.filterProject', 'Project Level')}
                    </button>
                  );
                })}
              </div>
              <div className="th-create-panel__readonly-row">
                <label className="th-create-panel__label">{t('agentsOverview.form.readonly', 'Readonly Mode')}</label>
                <Switch checked={readonly} onChange={(e) => setReadonly(e.target.checked)} size="small" />
              </div>
            </div>

            {toolNames.length > 0 && (
              <div className="th-create-panel__field">
                <label className="th-create-panel__label">
                  {t('agentsOverview.form.tools', 'Tools')}
                  <span className="th-create-panel__label-hint">
                    ({t('agentsOverview.form.toolsOptional', 'Optional')}, default tools will be used if none selected)
                  </span>
                </label>
                <div className="th-create-panel__tools">
                  {toolNames.map((tool) => (
                    <button
                      key={tool}
                      type="button"
                      className={`th-list__tool-item${selectedTools.has(tool) ? ' is-on' : ''}`}
                      onClick={() => toggleTool(tool)}
                    >
                      <span className="th-list__tool-item-name">{tool}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="th-create-panel__field">
              <label className="th-create-panel__label">{t('agentsOverview.form.prompt', 'System Prompt')}</label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('agentsOverview.form.promptPlaceholder', 'Enter system prompt to define agent behavior...')}
                rows={8}
              />
            </div>

            <div className="th-create-page__actions">
              <Button variant="secondary" size="small" onClick={openHome} disabled={submitting}>
                {t('agentsOverview.form.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" size="small" onClick={handleSubmit} disabled={submitting}>
                {submitting ? '…' : submitLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreateAgentPage;

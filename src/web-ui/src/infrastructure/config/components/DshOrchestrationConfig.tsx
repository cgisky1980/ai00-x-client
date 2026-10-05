/**
 * DshOrchestrationConfig — Agent 编排设置页。
 *
 * 两个区块：
 * 1. 帮手定义（<DSH_HOME>/agent-workers/*.md）：主对话的派发帮手（dsh-tool-subagent），
 *    markdown frontmatter（name/description/model/background/tools）+ 正文 persona；
 * 2. Claude Code 兼容 hooks（<DSH_HOME>/hooks.json）：引擎 dsh-hooks-claude-code 桥。
 *
 * 两者都在引擎启动时读取一次——改动后需重启引擎生效（页面提供一键重启入口）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Modal, Textarea } from '@/component-library';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  dshEngine,
  dshHooks,
  dshWorkers,
  type DshWorkerSummary,
} from '../../api/service-api/DshAPI';
import { ConfigPageHeader, ConfigPageLayout, ConfigPageContent, ConfigPageSection } from './common';
import './DshOrchestrationConfig.scss';

const log = createLogger('DshOrchestrationConfig');

const HOOKS_TEMPLATE = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|pwsh",
        "hooks": [
          { "type": "command", "command": "echo \\"$TOOL_NAME about to run\\"" }
        ]
      }
    ]
  }
}`;

const NEW_WORKER_TEMPLATE = `---
name: my_worker
description: 在这里写帮手定位（编排器按 description 选择派发）
model: ai00-auto
background: continuable
tools:
  - read
  - glob
  - grep
  - web_fetch
---
You are a worker dispatched by the Ai00-X orchestrator.
在这里写帮手的系统提示（职责、边界、产出格式）。
`;

export const DshOrchestrationConfig: React.FC = () => {
  const { t } = useTranslation('settings/dsh-orchestration');
  const notification = useNotification();

  // ---- 帮手定义 ----
  const [workers, setWorkers] = useState<DshWorkerSummary[]>([]);
  const [workersLoading, setWorkersLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorFile, setEditorFile] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DshWorkerSummary | null>(null);

  const loadWorkers = useCallback(async () => {
    try {
      setWorkersLoading(true);
      setWorkers(await dshWorkers.list());
    } catch (err) {
      log.error('Failed to load workers', err);
      notification.error(t('workers.loadFailed'));
    } finally {
      setWorkersLoading(false);
    }
  }, [notification, t]);

  const openEditor = async (fileName: string, content?: string): Promise<void> => {
    try {
      const text = content ?? (await dshWorkers.read(fileName));
      setEditorFile(fileName);
      setEditorContent(text);
      setEditorOpen(true);
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewWorker = (): void => {
    const fileName = window.prompt(t('workers.newPrompt'), 'my_worker.md');
    if (!fileName) return;
    const normalized = fileName.toLowerCase().endsWith('.md') ? fileName : `${fileName}.md`;
    void openEditor(normalized, NEW_WORKER_TEMPLATE.replace('name: my_worker', `name: ${normalized.replace(/\.md$/, '')}`));
  };

  const handleSaveWorker = async (): Promise<void> => {
    try {
      setSaving(true);
      await dshWorkers.save(editorFile, editorContent);
      notification.success(t('workers.saved', { file: editorFile }));
      setEditorOpen(false);
      await loadWorkers();
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteWorker = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await dshWorkers.delete(deleteTarget.fileName);
      notification.success(t('workers.deleted', { name: deleteTarget.name }));
      setDeleteTarget(null);
      await loadWorkers();
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- Hooks ----
  const [hooksContent, setHooksContent] = useState('');
  const [hooksLoading, setHooksLoading] = useState(true);
  const [hooksSaving, setHooksSaving] = useState(false);

  const loadHooks = useCallback(async () => {
    try {
      setHooksLoading(true);
      setHooksContent(await dshHooks.get());
    } catch (err) {
      log.error('Failed to load hooks config', err);
    } finally {
      setHooksLoading(false);
    }
  }, []);

  const handleSaveHooks = async (): Promise<void> => {
    try {
      setHooksSaving(true);
      await dshHooks.set(hooksContent);
      notification.success(t('hooks.saved'));
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    } finally {
      setHooksSaving(false);
    }
  };

  useEffect(() => {
    void loadWorkers();
    void loadHooks();
  }, [loadWorkers, loadHooks]);

  const handleRestartEngine = async (): Promise<void> => {
    try {
      await dshEngine.restart();
      notification.success(t('restart.done'));
    } catch (err) {
      notification.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <ConfigPageLayout>
      <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
      <ConfigPageContent>
        <ConfigPageSection
          title={t('workers.sectionTitle')}
          description={t('workers.sectionDesc')}
          extra={
            <Button variant="secondary" size="small" onClick={handleNewWorker}>
              <Plus size={13} />
              {t('workers.new')}
            </Button>
          }
        >
          {workersLoading && <p className="ai00-x-dsh-orch__hint">{t('common.loading')}</p>}
          {!workersLoading && workers.length === 0 && (
            <p className="ai00-x-dsh-orch__hint">{t('workers.empty')}</p>
          )}
          {workers.map(worker => (
            <div key={worker.fileName} className="ai00-x-dsh-orch__worker">
              <div className="ai00-x-dsh-orch__worker-main">
                <span className="ai00-x-dsh-orch__worker-name">{worker.name}</span>
                <span className="ai00-x-dsh-orch__worker-meta">
                  {worker.model} · {worker.background}
                </span>
                <span className="ai00-x-dsh-orch__worker-desc">{worker.description}</span>
                <div className="ai00-x-dsh-orch__worker-tools">
                  {worker.tools.map(tool => (
                    <code key={tool}>{tool}</code>
                  ))}
                </div>
              </div>
              <div className="ai00-x-dsh-orch__worker-actions">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => void openEditor(worker.fileName)}
                >
                  {t('workers.edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => setDeleteTarget(worker)}
                  aria-label={t('workers.delete')}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          ))}
        </ConfigPageSection>

        <ConfigPageSection
          title={t('hooks.sectionTitle')}
          description={t('hooks.sectionDesc')}
        >
          {hooksLoading ? (
            <p className="ai00-x-dsh-orch__hint">{t('common.loading')}</p>
          ) : (
            <>
              <Textarea
                value={hooksContent}
                onChange={e => setHooksContent(e.target.value)}
                rows={14}
                placeholder={HOOKS_TEMPLATE}
                className="ai00-x-dsh-orch__hooks-editor"
              />
              <div className="ai00-x-dsh-orch__hooks-actions">
                <Button variant="ghost" size="small" onClick={() => setHooksContent(HOOKS_TEMPLATE)}>
                  {t('hooks.fillTemplate')}
                </Button>
                <Button variant="ghost" size="small" onClick={() => setHooksContent('')}>
                  {t('hooks.clear')}
                </Button>
                <Button
                  variant="primary"
                  size="small"
                  disabled={hooksSaving}
                  onClick={() => void handleSaveHooks()}
                >
                  {t('common.save')}
                </Button>
              </div>
            </>
          )}
        </ConfigPageSection>

        <div className="ai00-x-dsh-orch__restart">
          <span className="ai00-x-dsh-orch__hint">{t('restart.hint')}</span>
          <Button variant="secondary" size="small" onClick={() => void handleRestartEngine()}>
            <RefreshCw size={13} />
            {t('restart.button')}
          </Button>
        </div>
      </ConfigPageContent>

      <Modal
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={t('workers.editorTitle', { file: editorFile })}
      >
        <div className="ai00-x-dsh-orch__editor-body">
          <p className="ai00-x-dsh-orch__hint">{t('workers.editorHint')}</p>
          <Textarea
            value={editorContent}
            onChange={e => setEditorContent(e.target.value)}
            rows={20}
            className="ai00-x-dsh-orch__hooks-editor"
          />
          <div className="ai00-x-dsh-orch__hooks-actions">
            <Button variant="secondary" size="small" onClick={() => setEditorOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="small"
              disabled={saving}
              onClick={() => void handleSaveWorker()}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('workers.deleteTitle', { name: deleteTarget?.name ?? '' })}
      >
        <p className="ai00-x-dsh-orch__hint">{t('workers.deleteConfirm')}</p>
        <div className="ai00-x-dsh-orch__hooks-actions">
          <Button variant="secondary" size="small" onClick={() => setDeleteTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="small" onClick={() => void handleDeleteWorker()}>
            {t('workers.delete')}
          </Button>
        </div>
      </Modal>
    </ConfigPageLayout>
  );
};

export default DshOrchestrationConfig;

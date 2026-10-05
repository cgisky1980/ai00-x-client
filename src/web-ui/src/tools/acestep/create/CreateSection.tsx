/**
 * CreateSection — 音乐创作分区（乐窗口内子分区）。
 *
 * 无顶栏、无手动加载步骤：引擎在点「生成」时自动初始化、结束自动卸载。
 * 结构 = 左侧创作列表（标题行含新建）+ 右侧按选中创作类型渲染的编辑器
 * （快捷 → QuickEditor 双卡；分轨 → TrackEditor 时间轴）。
 * 音乐模型（本地 DiT 档位）选择器位于各编辑器的生成按钮旁。
 */

import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BrandMark } from '@ai00-x/design-system/react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useVramContext } from '@/shared/vram';
import { useCreateStore } from './createStore';
import { useCreateEvents } from './useCreateEvents';
import './CreateSection.scss';

const QuickEditor = lazy(() => import('./QuickEditor'));
const TrackEditor = lazy(() => import('./TrackEditor'));
const RemixEditor = lazy(() => import('./RemixEditor'));
const CreationList = lazy(() => import('./CreationList'));

const CreateSection: React.FC = () => {
  const { t } = useI18n('acestep');
  useCreateEvents();
  useVramContext('music');

  const initialize = useCreateStore((s) => s.initialize);
  const loaded = useCreateStore((s) => s.loaded);
  const activeCreation = useCreateStore((s) => s.creations.find((c) => c.id === s.activeId));
  const error = useCreateStore((s) => s.error);
  const busyGenerating = useCreateStore((s) =>
    s.creations.some((c) => c.generating) || s.generatingTrackId !== null || s.engineBusy,
  );
  const progress = useCreateStore((s) => s.progress);

  const [listCollapsed, setListCollapsed] = useState(
    () => localStorage.getItem('ai00-x-create:listCollapsed') === '1',
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const toggleListCollapsed = (v: boolean) => {
    setListCollapsed(v);
    try {
      localStorage.setItem('ai00-x-create:listCollapsed', v ? '1' : '0');
    } catch {
      // ignore
    }
  };

  return (
    <div className="ai00-x-create">
      {busyGenerating && (
        <div className="ai00-x-create__busy">
          <BrandMark variant="seal" size={48} animated />
          <span>{t('create.generatingStatus')}</span>
          {progress && progress.total > 0 && (
            <div className="ai00-x-create__busy-progress">
              <div className="ai00-x-create__busy-progress-track">
                <div
                  className="ai00-x-create__busy-progress-fill"
                  style={{ width: `${Math.min(100, (progress.step / progress.total) * 100)}%` }}
                />
              </div>
              <span className="ai00-x-create__busy-progress-text">
                {progress.stageName} {progress.step}/{progress.total}
              </span>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="ai00-x-create__error">
          {error === 'MODEL_DOWNLOADING'
            ? t('create.modelDownloading')
            : error === 'NEED_STYLE'
              ? t('create.needStyle')
              : error === 'NEED_BASE_TRACK'
                ? t('create.needBase')
                : error === 'NOTHING_TO_EXPORT'
                  ? t('create.nothingToExport')
                : error === 'NEED_TRACK_PROMPT'
                  ? t('create.needTrackPrompt')
                  : error === 'NO_SOURCE'
                    ? t('create.remix.needSource')
                    : error === 'NO_MODEL'
                      ? t('create.noModel')
                      : error}
        </div>
      )}

      <div className={`ai00-x-create__body${listCollapsed ? ' is-list-collapsed' : ''}`}>
        {listCollapsed ? (
          <button
            type="button"
            className="ai00-x-create__list-expand"
            title={t('create.listExpand')}
            onClick={() => toggleListCollapsed(false)}
          >
            »
          </button>
        ) : (
          <Suspense fallback={null}>
            <CreationList onCollapse={() => setListCollapsed(true)} />
          </Suspense>
        )}
        <div className="ai00-x-create__editor">
          {!loaded ? (
            <div className="ai00-x-create__loading">
              <Loader2 size={18} className="ai00-x-create__spin" />
            </div>
          ) : activeCreation ? (
            <Suspense
              fallback={
                <div className="ai00-x-create__loading">
                  <Loader2 size={18} className="ai00-x-create__spin" />
                </div>
              }
            >
              {activeCreation.type === 'quick' ? (
                <QuickEditor creationId={activeCreation.id} />
              ) : activeCreation.type === 'remix' ? (
                <RemixEditor creationId={activeCreation.id} />
              ) : (
                <TrackEditor creationId={activeCreation.id} />
              )}
            </Suspense>
          ) : (
            <div className="ai00-x-create__empty">
              <p>{t('create.emptyHint')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CreateSection;

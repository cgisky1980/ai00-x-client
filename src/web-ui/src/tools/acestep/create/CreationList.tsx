/**
 * CreationList — left rail listing every creation (quick + track).
 * Header row hosts the ＋新建创作 dropdown (quick / track); rows show type
 * badge, sample count / status; click to open; hover to delete.
 */

import React, { useState } from 'react';
import { Trash2, ListMusic, AudioLines, Disc3, Scissors, Plus, ChevronDown, ChevronsLeft } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import { useCreateStore } from './createStore';
import { isRemixUiEnabled } from './featureFlags';

const CreationList: React.FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
  const { t } = useI18n('acestep');
  const creations = useCreateStore((s) => s.creations);
  const activeId = useCreateStore((s) => s.activeId);
  const selectCreation = useCreateStore((s) => s.selectCreation);
  const deleteCreation = useCreateStore((s) => s.deleteCreation);
  const createCreation = useCreateStore((s) => s.createCreation);
  const generatingTrackId = useCreateStore((s) => s.generatingTrackId);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  const handleCreate = async (type: 'quick' | 'track' | 'remix', remixMode?: 'cover' | 'repaint') => {
    setNewMenuOpen(false);
    await createCreation(type, remixMode ? { remixMode } : undefined);
  };

  return (
    <div className="ai00-x-create-list">
      <div className="ai00-x-create-list__header">
        <span>{t('create.listTitle')}</span>
        <button
          type="button"
          className="ai00-x-create-list__collapse"
          title={t('create.listCollapse')}
          onClick={() => onCollapse?.()}
        >
          <ChevronsLeft size={13} />
        </button>
        <Popover open={newMenuOpen} onOpenChange={setNewMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="ai00-x-create-list__new"
              title={t('create.newCreation')}
            >
              <Plus size={13} />
              {t('create.newCreation')}
              <ChevronDown size={11} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="ai00-x-create__new-menu">
            <button type="button" className="ai00-x-create__new-item" onClick={() => void handleCreate('quick')}>
              {t('create.newQuick')}
            </button>
            {isRemixUiEnabled() && (
              <>
                <button type="button" className="ai00-x-create__new-item" onClick={() => void handleCreate('remix', 'cover')}>
                  {t('create.newRemix')}
                </button>
                <button type="button" className="ai00-x-create__new-item" onClick={() => void handleCreate('remix', 'repaint')}>
                  {t('create.newRepaint')}
                </button>
              </>
            )}
            <button type="button" className="ai00-x-create__new-item" onClick={() => void handleCreate('track')}>
              {t('create.newTrack')}
            </button>
          </PopoverContent>
        </Popover>
      </div>
      <div className="ai00-x-create-list__items">
        {creations.map((c) => {
          const busy =
            c.generating ||
            (c.type === 'track' &&
              generatingTrackId !== null &&
              c.tracks.some((tr) => tr.id === generatingTrackId));
          return (
            <div
              key={c.id}
              className={`ai00-x-create-list__item${c.id === activeId ? ' is-active' : ''}`}
              onClick={() => selectCreation(c.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectCreation(c.id);
              }}
            >
              <span className="ai00-x-create-list__icon">
                {c.type === 'quick' ? (
                  <ListMusic size={14} />
                ) : c.type === 'remix' ? (
                  c.remixParams?.mode === 'repaint' ? (
                    <Scissors size={14} />
                  ) : (
                    <Disc3 size={14} />
                  )
                ) : (
                  <AudioLines size={14} />
                )}
              </span>
              <span className="ai00-x-create-list__main">
                <span className="ai00-x-create-list__title">{c.title}</span>
                <span className="ai00-x-create-list__meta">
                  <span className={`ai00-x-create-list__badge ai00-x-create-list__badge--${c.type}`}>
                    {c.type === 'quick'
                      ? t('create.typeQuick')
                      : c.type === 'remix'
                        ? t('create.typeRemix')
                        : t('create.typeTrack')}
                  </span>
                  <span>
                    {busy
                      ? t('create.listBusy')
                      : c.type === 'track'
                        ? t('create.listTrackStat', { tracks: c.tracks.length, samples: c.samples.length })
                        : t('create.listSampleCount', { count: c.samples.length })}
                  </span>
                </span>
              </span>
              <button
                type="button"
                className="ai00-x-create-list__delete"
                title={t('create.deleteCreation')}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteCreation(c.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CreationList;

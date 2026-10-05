/**
 * SendToRemixButton — 「送去改歌 / 送去局部重绘」小按钮（Popover 两项菜单）。
 *
 * 点击后：以给定音频为源新建预填 remix 创作并选中，再经 `music://navigate`
 * 跳到创作分区（同窗口内 My Works / 样例卡 → 创作工作台）。
 */

import React, { useState } from 'react';
import { Disc3, Scissors } from 'lucide-react';
import { emit } from '@tauri-apps/api/event';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import { toastSuccess, toastError } from '@/component-library';
import { aceStepService } from '../services/AceStepService';
import { useCreateStore } from './createStore';
import { isRemixUiEnabled } from './featureFlags';
import type { RemixMode } from './types';
import type { SongEntry } from '../types';
import './SendToRemixButton.scss';

interface Props {
  /** 直接可用的本地音频路径（样例卡场景）。 */
  audioPath?: string;
  /** 曲库 .a00m 条目（我的作品场景；发送前自动解包取音频）。 */
  entry?: SongEntry;
  name: string;
  durationSeconds?: number;
}

const SendToRemixButton: React.FC<Props> = ({ audioPath, entry, name, durationSeconds }) => {
  const { t } = useI18n('acestep');
  const sendToRemix = useCreateStore((s) => s.sendToRemix);
  const [open, setOpen] = useState(false);

  if (!isRemixUiEnabled()) return null;

  const send = async (mode: RemixMode) => {
    setOpen(false);
    try {
      let path = audioPath;
      let duration = durationSeconds;
      if (entry) {
        const unpacked = await aceStepService.unpackSong(entry.path, null);
        path = unpacked.audioPath;
        if (!duration) duration = entry.meta?.durationSeconds ?? 0;
      }
      if (!path) {
        toastError(t('create.remix.needSource'));
        return;
      }
      await sendToRemix({ path, name, durationSeconds: duration }, mode);
      await emit('music://navigate', { section: 'compose' });
      toastSuccess(t('create.remix.sentToast'));
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ai00-x-send-remix"
          title={t('create.remix.sendTitle')}
          disabled={!audioPath && !entry}
        >
          <Disc3 size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="ai00-x-send-remix__menu">
        <button type="button" className="ai00-x-send-remix__item" onClick={() => void send('cover')}>
          <Disc3 size={13} />
          {t('create.remix.sendToRemix')}
        </button>
        <button type="button" className="ai00-x-send-remix__item" onClick={() => void send('repaint')}>
          <Scissors size={13} />
          {t('create.remix.sendToRepaint')}
        </button>
      </PopoverContent>
    </Popover>
  );
};

export default SendToRemixButton;

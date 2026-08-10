/**
 * AudioPlayer — plays a local wav file via Tauri's asset protocol.
 *
 * In Tauri 2.0 webview, local files are served via `https://asset.localhost/<path>`.
 * In a plain browser dev environment, the file is unavailable — a fallback notice
 * is shown in that case.
 */

import React, { useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from '@/infrastructure/i18n';
import './AudioPlayer.scss';

interface AudioPlayerProps {
  /** Absolute local file path returned by the backend. */
  filePath: string;
}

function isTauriEnv(): boolean {
  // Tauri injects `window.__TAURI__` in both dev (Vite dev server) and
  // production builds. Checking the hostname fails in dev mode because the
  // webview loads `http://localhost:1422`, not `tauri.localhost`.
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ filePath }) => {
  const { t } = useI18n('acestep');
  const [loadFailed, setLoadFailed] = useState(false);

  // convertFileSrc uses encodeURIComponent internally, correctly handling
  // Windows backslash paths. Manual encodeURI leaves '\' unencoded which
  // produces an invalid URL that <audio> cannot load.
  const src = useMemo(() => convertFileSrc(filePath), [filePath]);
  const inTauri = isTauriEnv();

  if (!inTauri) {
    return (
      <div className="acestep-audio__notice">
        {t('stepBuilder.audioLoadFailed')} (browser dev — file: {filePath})
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="acestep-audio__notice acestep-audio__notice--error">
        {t('stepBuilder.audioLoadFailed')}
      </div>
    );
  }

  return (
    <audio
      className="acestep-audio"
      src={src}
      controls
      onError={() => setLoadFailed(true)}
    >
      {t('stepBuilder.audioLoadFailed')}
    </audio>
  );
};

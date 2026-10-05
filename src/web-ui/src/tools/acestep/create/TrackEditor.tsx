/**
 * TrackEditor — 分轨创作编辑器（图 B）。
 *
 * 时间轴多轨界面：传输控制 + 每轨轨头（音量/静音/独奏/换一版/删除）+
 * canvas 波形 clip + 播放头 + 添加音轨弹层 + 导出成品。播放真相 =
 * Web Audio 实时混音（audioEngine），导出 = 按当前调音离线渲染。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Square,
  Plus,
  Download,
  RefreshCw,
  Trash2,
  Loader2,
  Library,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Button, Textarea } from '@/component-library';
import { useCreateStore } from './createStore';
import { audioEngine } from './audioEngine';
import ModelSelector from './ModelSelector';
import type { Creation, CreationSample, CreationTrack } from './types';
import AddTrackDialog from './AddTrackDialog';
import PackageDialog from './PackageDialog';
import './TrackEditor.scss';

interface Props {
  creationId: string;
}

const RulerMarks: React.FC<{ duration: number }> = ({ duration }) => {
  if (duration <= 0) return null;
  const marks = 6;
  return (
    <>
      {Array.from({ length: marks + 1 }, (_, i) => (
        <span key={i} className="ai00-x-track__ruler-mark" style={{ left: `${(i / marks) * 100}%` }}>
          {formatTime((i / marks) * duration)}
        </span>
      ))}
    </>
  );
};

/** Canvas waveform of a stem (accent-colored, redraws on width change). */
const WaveformCanvas: React.FC<{ stemPath: string }> = ({ stemPath }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const draw = async () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (width === 0 || height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      let buffer;
      try {
        buffer = await audioEngine.loadBuffer(stemPath);
      } catch {
        return;
      }
      if (cancelled) return;
      const peaks = audioEngine.computePeaks(buffer, Math.max(1, Math.floor(width / 2)));
      const style = getComputedStyle(wrap);
      ctx.fillStyle = style.getPropertyValue('--color-accent-500') || '#60a5fa';
      const mid = height / 2;
      for (let col = 0; col < peaks.length / 2; col++) {
        const min = peaks[col * 2];
        const max = peaks[col * 2 + 1];
        const y1 = mid - max * (mid - 1);
        const y2 = mid - min * (mid - 1);
        ctx.fillRect(col * 2, y1, 1.5, Math.max(1, y2 - y1));
      }
    };
    void draw();
    const observer = new ResizeObserver(() => void draw());
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [stemPath]);

  return (
    <div className="ai00-x-track__wave" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
};

interface TrackRowProps {
  creation: Creation;
  track: CreationTrack;
  duration: number;
  playhead: number;
  busy: boolean;
  anyBusy: boolean;
  onGain: (gainDb: number) => void;
  onMute: (muted: boolean) => void;
  onSolo: (solo: boolean) => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

const TrackRow: React.FC<TrackRowProps> = ({
  creation,
  track,
  duration,
  playhead,
  busy,
  anyBusy,
  onGain,
  onMute,
  onSolo,
  onRegenerate,
  onDelete,
}) => {
  const { t } = useI18n('acestep');
  const widthPct =
    duration > 0
      ? Math.min(100, (trackDuration(creation, track) / duration) * 100)
      : track.status === 'ready'
        ? 100
        : 0;

  return (
    <div className={`ai00-x-track__row${busy ? ' is-busy' : ''}`}>
      <div className="ai00-x-track__head">
        <span className="ai00-x-track__head-name">{track.name}</span>
        {track.status === 'generating' && <Loader2 size={12} className="ai00-x-create__spin" />}
        <input
          className="ai00-x-track__gain"
          type="range"
          min={-30}
          max={6}
          step={1}
          value={track.gainDb}
          disabled={track.status !== 'ready'}
          onChange={(e) => onGain(Number(e.target.value))}
          title={`${track.gainDb} dB`}
        />
        <button
          type="button"
          className={`ai00-x-track__ms${track.muted ? ' is-on' : ''}`}
          disabled={track.status !== 'ready'}
          onClick={() => onMute(!track.muted)}
          title={t('trackEditor.mute')}
        >
          M
        </button>
        <button
          type="button"
          className={`ai00-x-track__ms${track.solo ? ' is-on' : ''}`}
          disabled={track.status !== 'ready'}
          onClick={() => onSolo(!track.solo)}
          title={t('trackEditor.solo')}
        >
          S
        </button>
        <button
          type="button"
          className="ai00-x-track__op"
          disabled={anyBusy}
          onClick={onRegenerate}
          title={t('create.retake')}
        >
          <RefreshCw size={12} />
        </button>
        <button type="button" className="ai00-x-track__op" onClick={onDelete} title={t('trackEditor.deleteTrack')}>
          <Trash2 size={12} />
        </button>
      </div>
      <div className="ai00-x-track__lane">
        {track.status === 'ready' && track.stemPath && (
          <div className="ai00-x-track__clip" style={{ width: `${widthPct}%` }}>
            <WaveformCanvas stemPath={track.stemPath} />
          </div>
        )}
        {track.status === 'error' && <span className="ai00-x-track__lane-error">{track.error}</span>}
        <div
          className="ai00-x-track__playhead"
          style={{ left: `${duration > 0 ? Math.min(100, (playhead / duration) * 100) : 0}%` }}
        />
      </div>
    </div>
  );
};

function trackDuration(creation: Creation, track: CreationTrack): number {
  const sample = creation.samples.find((s) => s.audioPath === track.mixPath);
  return sample?.durationSeconds ?? 0;
}

const SampleList: React.FC<{
  creation: Creation;
  onDelete: (sampleId: string) => void;
}> = ({ creation, onDelete }) => {
  const { t } = useI18n('acestep');
  const [packagingSampleId, setPackagingSampleId] = useState<string | null>(null);
  return (
    <div className="ai00-x-track__samples">
      <header className="ai00-x-track__samples-head">
        {t('trackEditor.samplesTitle')}
        <span className="ai00-x-track__samples-count">{creation.samples.length}</span>
      </header>
      <div className="ai00-x-track__samples-list">
        {creation.samples.map((sample: CreationSample, i: number) => (
          <div key={sample.id} className="ai00-x-quick__sample">
            <div className="ai00-x-quick__sample-head">
              <span className="ai00-x-quick__sample-label">
                {t('trackEditor.exportN', { index: i + 1 })}
              </span>
              <div className="ai00-x-quick__sample-actions">
                <Button size="small" variant="ghost" disabled={sample.inLibrary} onClick={() => setPackagingSampleId(sample.id)}>
                  <Library size={12} />
                  {sample.inLibrary ? t('create.inLibrary') : t('create.saveToLibrary')}
                </Button>
                <Button size="small" variant="ghost" onClick={() => onDelete(sample.id)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <PackageDialog
        open={packagingSampleId !== null}
        creationId={creation.id}
        sampleId={packagingSampleId}
        onClose={() => setPackagingSampleId(null)}
      />
    </div>
  );
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const TrackEditor: React.FC<Props> = ({ creationId }) => {
  const { t } = useI18n('acestep');
  const creation = useCreateStore((s) => s.creations.find((c) => c.id === creationId));
  const updateTrack = useCreateStore((s) => s.updateTrack);
  const removeTrack = useCreateStore((s) => s.removeTrack);
  const generateTrack = useCreateStore((s) => s.generateTrack);
  const regenerateTrack = useCreateStore((s) => s.regenerateTrack);
  const patchParams = useCreateStore((s) => s.patchParams);
  const patchCreation = useCreateStore((s) => s.patchCreation);
  const exportMix = useCreateStore((s) => s.exportMix);
  const deleteSample = useCreateStore((s) => s.deleteSample);
  const generatingTrackId = useCreateStore((s) => s.generatingTrackId);

  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [basePrompt, setBasePrompt] = useState('');
  const rafRef = useRef<number>(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  const readyTracks = useMemo(
    () =>
      (creation?.tracks ?? [])
        .filter((tr) => tr.status === 'ready' && tr.stemPath)
        .map((tr) => ({
          trackId: tr.id,
          stemPath: tr.stemPath as string,
          gainDb: tr.gainDb,
          muted: tr.muted,
          solo: tr.solo,
        })),
    [creation?.tracks],
  );

  // Total duration follows the longest ready track.
  useEffect(() => {
    let cancelled = false;
    void audioEngine.duration(readyTracks).then((d) => {
      if (!cancelled) setDuration(d);
    });
    return () => {
      cancelled = true;
    };
  }, [readyTracks]);

  // Live gain/mute/solo updates while playing.
  useEffect(() => {
    if (playing) void audioEngine.applyMix(readyTracks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyTracks]);

  // Stop playback when leaving the editor.
  useEffect(() => {
    return () => {
      audioEngine.stop();
      cancelAnimationFrame(rafRef.current);
    };
  }, [creationId]);

  const tick = useCallback(() => {
    setPlayhead(audioEngine.currentTime());
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const handlePlayPause = async () => {
    if (playing) {
      audioEngine.pause();
      cancelAnimationFrame(rafRef.current);
      setPlaying(false);
    } else {
      await audioEngine.play(readyTracks, playhead >= duration ? 0 : playhead);
      setPlaying(true);
      rafRef.current = requestAnimationFrame(tick);
    }
  };

  const handleStop = () => {
    audioEngine.stop();
    cancelAnimationFrame(rafRef.current);
    setPlaying(false);
    setPlayhead(0);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * duration;
    setPlayhead(target);
    if (playing) void audioEngine.play(readyTracks, target);
  };

  if (!creation) return null;

  const baseTrack = creation.tracks.find((tr) => tr.kind === 'base');
  const busy = generatingTrackId !== null;

  return (
    <div className="ai00-x-track">
      {/* ---- 传输条 ---- */}
      <div className="ai00-x-track__transport">
        <Button size="small" variant="ghost" onClick={() => void handlePlayPause()} disabled={readyTracks.length === 0}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </Button>
        <Button size="small" variant="ghost" onClick={handleStop} disabled={!playing && playhead === 0}>
          <Square size={12} />
        </Button>
        <span className="ai00-x-track__time">
          {formatTime(playhead)} / {formatTime(duration)}
        </span>
        <div className="ai00-x-track__transport-spacer" />
        <label className="ai00-x-track__duration">
          <span>{t('create.paramDuration')}</span>
          <input
            type="number"
            min={30}
            max={300}
            step={10}
            value={creation.params.durationSec || ''}
            placeholder="auto"
            disabled={Boolean(baseTrack && baseTrack.status !== 'empty')}
            onChange={(e) => patchParams(creationId, { durationSec: Number(e.target.value) || 0 })}
          />
        </label>
        <ModelSelector />
        <Button size="small" variant="secondary" onClick={() => void exportMix(creationId)}>
          <Download size={12} />
          {t('trackEditor.export')}
        </Button>
      </div>

      {/* ---- 时间轴 ---- */}
      <div className="ai00-x-track__timeline" ref={timelineRef} onClick={handleSeek} role="presentation">
        <div className="ai00-x-track__ruler">
          <RulerMarks duration={duration} />
        </div>
        {creation.tracks.map((track) => (
          <TrackRow
            key={track.id}
            creation={creation}
            track={track}
            duration={duration}
            playhead={playhead}
            busy={generatingTrackId === track.id}
            anyBusy={busy}
            onGain={(gainDb) => updateTrack(creationId, track.id, { gainDb })}
            onMute={(muted) => updateTrack(creationId, track.id, { muted })}
            onSolo={(solo) => updateTrack(creationId, track.id, { solo })}
            onRegenerate={() => void regenerateTrack(creationId, track.id)}
            onDelete={() => removeTrack(creationId, track.id)}
          />
        ))}
        {!baseTrack && (
          <div className="ai00-x-track__base-form">
            <p>{t('trackEditor.baseFormTitle')}</p>
            <Textarea
              rows={2}
              value={basePrompt}
              placeholder={t('trackEditor.baseFormPlaceholder')}
              onChange={(e) => setBasePrompt(e.target.value)}
            />
            <Button
              size="small"
              disabled={!basePrompt.trim() || busy}
              onClick={() => {
                void (async () => {
                  patchCreation(creationId, { styleInput: basePrompt.trim() });
                  const trackId = await useCreateStore
                    .getState()
                    .addTrack(creationId, 'base', t('trackEditor.kindBase'), basePrompt.trim());
                  setBasePrompt('');
                  await generateTrack(creationId, trackId);
                })();
              }}
            >
              <Plus size={12} />
              {t('trackEditor.generateBase')}
            </Button>
          </div>
        )}
      </div>

      {/* 成品样例：右侧整列（grid-area: samples） */}
      <SampleList
        creation={creation}
        onDelete={(sid) => deleteSample(creationId, sid)}
      />

      <div className="ai00-x-track__footer">
        <Button
          size="small"
          variant="secondary"
          disabled={busy || !baseTrack || baseTrack.status !== 'ready'}
          onClick={() => setAddOpen(true)}
        >
          <Plus size={12} />
          {t('trackEditor.addTrack')}
        </Button>
      </div>

      <AddTrackDialog
        open={addOpen}
        creationId={creationId}
        onClose={() => setAddOpen(false)}
      />
    </div>
  );
};

export default TrackEditor;

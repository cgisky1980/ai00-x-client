/**
 * RemixEditor — 改歌 / 局部重绘编辑器。
 *
 * 源音频（上传 / 录音哼唱 / 收藏 / 我的作品，经 AudioSourcePicker）+
 * 模式三选（翻唱重编 cover / 忠实重混 cover-nofsq / 局部重绘 repaint）+
 * 描述与歌词（复用快捷创作的 AI 润色链）。生成走 generateRemix：
 * cover/repaint 的输出时长由引擎按源音频决定，因此不提供时长选项。
 */

import React, { useMemo, useRef, useState } from 'react';
import { Sparkles, Loader2, Library, RefreshCw, Trash2, Check, X, Music, Timer, Rewind, FastForward } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { toastError, toastSuccess } from '@/component-library';
import { Button, Textarea, Select, Switch } from '@/component-library';
import type { SelectOption } from '@/component-library';
import { useCreateStore } from './createStore';
import LyricsSegmentsEditor from './LyricsSegmentsEditor';
import ModelSelector from './ModelSelector';
import SamplePlayer from './SamplePlayer';
import { ScoreBadge } from '../components/ScoreBadge';
import ModelSelectorShared from '@/shared/components/ModelSelector';
import { BrandMark } from '@ai00-x/design-system/react';
import AudioSourcePicker from './AudioSourcePicker';
import SendToRemixButton from './SendToRemixButton';
import PackageDialog from './PackageDialog';
import { optimizeStyle, writeLyrics, parseLyricsResponse } from './musicAgent';
import type { StyleOptimization, LyricsJson } from './musicAgent';
import { truncateLyricsContext } from './agentPrompts';
import { serializeLyrics } from './tagCatalog';
import { LYRIC_TEMPLATES, INSTRUMENTAL_TEMPLATE_ID } from './lyricTemplates';
import { newId } from './types';
import type { RemixMode } from './types';
import './RemixEditor.scss';

interface Props {
  creationId: string;
}

/** 单次重绘/延长的合法区间长度（官方限制）。 */
const REGION_MIN_SEC = 3;
const REGION_MAX_SEC = 90;
const EXTEND_STEP_SEC = 30;

const RemixEditor: React.FC<Props> = ({ creationId }) => {
  const { t } = useI18n('acestep');
  const creation = useCreateStore((s) => s.creations.find((c) => c.id === creationId));
  const patchCreation = useCreateStore((s) => s.patchCreation);
  const patchParams = useCreateStore((s) => s.patchParams);
  const patchRemix = useCreateStore((s) => s.patchRemixParams);
  const acceptOptimization = useCreateStore((s) => s.acceptStyleOptimization);
  const clearOptimization = useCreateStore((s) => s.clearStyleOptimization);
  const generateRemix = useCreateStore((s) => s.generateRemix);
  const generateProgress = useCreateStore((s) => s.generateProgress);
  const deleteSample = useCreateStore((s) => s.deleteSample);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [styleOptimizing, setStyleOptimizing] = useState(false);
  const [lyricsWriting, setLyricsWriting] = useState(false);
  const [optimization, setOptimization] = useState<StyleOptimization | null>(null);
  const [lyricsStream, setLyricsStream] = useState<string | null>(null);
  const [lyricsPreview, setLyricsPreview] = useState<LyricsJson | null>(null);
  const [templateId, setTemplateId] = useState<string>(LYRIC_TEMPLATES[0].id);
  const [packagingSampleId, setPackagingSampleId] = useState<string | null>(null);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [styleInput, setStyleInput] = useState('');
  const lastStyleBrief = useRef('');
  const lastLyricsBrief = useRef('');

  const rp = creation?.remixParams;

  const templateOptions: SelectOption[] = useMemo(
    () => [
      ...LYRIC_TEMPLATES.map((tpl) => ({ value: tpl.id, label: tpl.nameZh })),
      { value: INSTRUMENTAL_TEMPLATE_ID, label: t('create.templateInstrumental') },
    ],
    [t],
  );

  const languageOptions: SelectOption[] = [
    { value: 'auto', label: t('create.langAuto') },
    { value: 'zh', label: t('create.langZh') },
    { value: 'en', label: t('create.langEn') },
    { value: 'ja', label: t('create.langJa') },
    { value: 'ko', label: t('create.langKo') },
  ];

  if (!creation || !rp) return null;

  const lyricsDisabled = creation.params.instrumental;
  const srcDur = rp.sourceDurationSec;

  /** 当前生效的重绘区间（秒）：end<0 视为源结尾；源时长未知时返回 null。 */
  const regionSecs = (): number | null => {
    if (rp.mode !== 'repaint') return null;
    const end = rp.repaintEnd < 0 ? srcDur : rp.repaintEnd;
    if (srcDur <= 0 && rp.repaintEnd < 0) return null;
    return Math.abs(end - rp.repaintStart);
  };

  const regionLen = regionSecs();
  const regionInvalid =
    rp.mode === 'repaint' &&
    regionLen !== null &&
    (regionLen < REGION_MIN_SEC || regionLen > REGION_MAX_SEC);

  const canGenerate = rp.sourcePath.length > 0 && !regionInvalid;

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (id === INSTRUMENTAL_TEMPLATE_ID) {
      patchParams(creationId, { instrumental: true });
      return;
    }
    const tpl = LYRIC_TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    patchParams(creationId, { instrumental: false });
    patchCreation(creationId, {
      lyricsSegments: tpl.blocks.map((b) => ({
        id: newId('seg'),
        kind: b.tag,
        lines: [...b.sample],
      })),
    });
  };

  const handleOptimizeStyle = async (): Promise<void> => {
    if (styleOptimizing) return;
    setStyleOptimizing(true);
    try {
      const lyricsContext = truncateLyricsContext(
        serializeLyrics(creation.lyricsSegments.filter((s) => s.lines.length > 0)),
      );
      const result = await optimizeStyle({
        brief: styleInput.trim(),
        lyricsContext: lyricsDisabled ? undefined : lyricsContext || undefined,
        instrumental: lyricsDisabled,
        model: creation.aiModel ?? undefined,
      });
      setOptimization(result);
      lastStyleBrief.current = styleInput.trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toastError(
        msg === 'AI_SERVICE_UNREACHABLE'
          ? t('create.aiUnavailable')
          : msg === 'AI_BAD_JSON'
            ? t('create.aiBadJson')
            : msg,
      );
    } finally {
      setStyleOptimizing(false);
    }
  };

  const handleWriteLyrics = async (): Promise<void> => {
    if (lyricsWriting) return;
    lastLyricsBrief.current = styleInput.trim();
    setLyricsWriting(true);
    setLyricsStream('');
    try {
      const existing = serializeLyrics(creation.lyricsSegments.filter((s) => s.lines.length > 0));
      const tpl = LYRIC_TEMPLATES.find((x) => x.id === templateId);
      const text = await writeLyrics({
        theme: styleInput.trim(),
        existingLyrics: existing || undefined,
        templateName: tpl?.nameZh,
        templateStructure: tpl ? tpl.blocks.map((b) => b.tag).join(' → ') : undefined,
        caption: creation.optimizedCaption || undefined,
        vocalLanguage: creation.params.vocalLanguage || undefined,
        model: creation.aiModel ?? undefined,
        onDelta: (d) => setLyricsStream((prev) => (prev ?? '') + d),
      });
      setLyricsPreview(parseLyricsResponse(text));
      setLyricsStream(null);
    } catch (e) {
      setLyricsStream(null);
      const msg = e instanceof Error ? e.message : String(e);
      toastError(
        msg === 'AI_SERVICE_UNREACHABLE'
          ? t('create.aiUnavailable')
          : msg === 'AI_BAD_JSON'
            ? t('create.aiBadJson')
            : msg,
      );
    } finally {
      setLyricsWriting(false);
    }
  };

  const acceptLyricsPreview = () => {
    if (!lyricsPreview) return;
    patchCreation(creationId, {
      lyricsSegments: lyricsPreview.segments.map((s) => ({
        id: newId('seg'),
        kind: s.tag,
        descriptors: s.descriptors.length > 0 ? s.descriptors : undefined,
        lines: s.lines,
      })),
    });
    setLyricsPreview(null);
    setStyleInput('');
    toastSuccess(t('create.aiLyricsApplied'));
  };

  const acceptOptimizationResult = (opt: StyleOptimization) => {
    acceptOptimization(creationId, opt.caption, opt.captionZh, 0);
    if (!creation.params.instrumental && ['zh', 'en', 'ja', 'ko'].includes(opt.vocal_language)) {
      patchParams(creationId, { vocalLanguage: opt.vocal_language });
    }
    setOptimization(null);
    setStyleInput('');
  };

  const setMode = (mode: RemixMode) => {
    patchRemix(creationId, { mode });
    // 模式切换时给强度一个合理默认：nofsq 官方推荐 0.2-0.5。
    if (mode === 'nofsq' && rp.coverStrength > 0.6) patchRemix(creationId, { coverStrength: 0.35 });
    if (mode === 'cover' && rp.coverStrength < 0.6) patchRemix(creationId, { coverStrength: 1.0 });
  };

  const setExtendBefore = () => {
    patchRemix(creationId, { repaintStart: -EXTEND_STEP_SEC, repaintEnd: -1 });
  };

  const setExtendAfter = () => {
    if (srcDur <= 0) return;
    patchRemix(creationId, {
      repaintStart: Math.round(srcDur * 10) / 10,
      repaintEnd: Math.round((srcDur + EXTEND_STEP_SEC) * 10) / 10,
    });
  };

  const modeCards: Array<{ id: RemixMode; titleKey: string; descKey: string }> = [
    { id: 'cover', titleKey: 'create.remix.modeCover', descKey: 'create.remix.modeCoverDesc' },
    { id: 'nofsq', titleKey: 'create.remix.modeNofsq', descKey: 'create.remix.modeNofsqDesc' },
    { id: 'repaint', titleKey: 'create.remix.modeRepaint', descKey: 'create.remix.modeRepaintDesc' },
  ];

  return (
    <div className="ai00-x-remix">
      {/* ---- 源音频 + 模式 ---- */}
      <section className="ai00-x-remix__source-row">
        <div className="ai00-x-remix__source">
          <span className="ai00-x-remix__field-label">{t('create.remix.sourceLabel')}</span>
          {rp.sourcePath ? (
            <div className="ai00-x-remix__source-picked">
              <Music size={14} />
              <span className="ai00-x-remix__source-name">{rp.sourceName}</span>
              {srcDur > 0 && (
                <span className="ai00-x-remix__source-duration">{formatClock(srcDur)}</span>
              )}
              <Button size="small" variant="ghost" onClick={() => setPickerOpen(true)}>
                {t('create.remix.changeSource')}
              </Button>
            </div>
          ) : (
            <Button size="small" onClick={() => setPickerOpen(true)}>
              <Music size={13} />
              {t('create.remix.pickSource')}
            </Button>
          )}
        </div>

        <div className="ai00-x-remix__modes">
          {modeCards.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`ai00-x-remix__mode${rp.mode === m.id ? ' is-active' : ''}`}
              onClick={() => setMode(m.id)}
            >
              <span className="ai00-x-remix__mode-title">{t(m.titleKey)}</span>
              <span className="ai00-x-remix__mode-desc">{t(m.descKey)}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ---- 模式参数 ---- */}
      {(rp.mode === 'cover' || rp.mode === 'nofsq') && (
        <section className="ai00-x-remix__strength">
          <span className="ai00-x-remix__field-label">{t('create.remix.strengthLabel')}</span>
          <div className="ai00-x-remix__strength-row">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={rp.coverStrength}
              disabled={creation.generating}
              onChange={(e) => patchRemix(creationId, { coverStrength: Number(e.target.value) })}
            />
            <span className="ai00-x-remix__strength-value">{rp.coverStrength.toFixed(2)}</span>
          </div>
          <p className="ai00-x-remix__strength-hint">
            {rp.mode === 'nofsq'
              ? t('create.remix.strengthNofsqHint')
              : t('create.remix.strengthCoverHint')}
          </p>
        </section>
      )}

      {rp.mode === 'repaint' && (
        <section className="ai00-x-remix__region">
          <div className="ai00-x-remix__region-inputs">
            <label>
              <span>{t('create.remix.regionStart')}</span>
              <input
                type="number"
                step={1}
                value={rp.repaintStart}
                disabled={creation.generating}
                onChange={(e) => patchRemix(creationId, { repaintStart: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              <span>{t('create.remix.regionEnd')}</span>
              <input
                type="number"
                step={1}
                value={rp.repaintEnd}
                disabled={creation.generating}
                onChange={(e) =>
                  patchRemix(creationId, {
                    repaintEnd: e.target.value === '' ? -1 : Number(e.target.value),
                  })
                }
              />
            </label>
            <span className="ai00-x-remix__region-meta">
              {srcDur > 0
                ? t('create.remix.sourceDuration', { time: formatClock(srcDur) })
                : t('create.remix.sourceUnknown')}
              {regionLen !== null && (
                <Timer size={12} />
              )}
              {regionLen !== null && ` ≈${regionLen.toFixed(0)}s`}
            </span>
          </div>
          <div className="ai00-x-remix__region-presets">
            <Button
              size="small"
              variant="ghost"
              disabled={creation.generating || srcDur <= 0}
              onClick={() => patchRemix(creationId, { repaintStart: 0, repaintEnd: Math.min(REGION_MAX_SEC, srcDur || REGION_MAX_SEC) })}
            >
              {t('create.remix.presetRegion')}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={creation.generating}
              onClick={setExtendBefore}
            >
              <Rewind size={12} />
              {t('create.remix.presetExtendBefore', { sec: EXTEND_STEP_SEC })}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={creation.generating || srcDur <= 0}
              onClick={setExtendAfter}
            >
              <FastForward size={12} />
              {t('create.remix.presetExtendAfter', { sec: EXTEND_STEP_SEC })}
            </Button>
          </div>
          <p className={`ai00-x-remix__region-hint${regionInvalid ? ' is-invalid' : ''}`}>
            {regionInvalid
              ? t('create.remix.regionInvalid', { min: REGION_MIN_SEC, max: REGION_MAX_SEC })
              : t('create.remix.regionHint')}
          </p>
        </section>
      )}

      {/* ---- 描述卡 ---- */}
      <section className="ai00-x-remix__card">
        <header className="ai00-x-remix__card-head">
          <h3>{t('create.remix.styleTitle')}</h3>
        </header>
        {styleOptimizing && (
          <div className="ai00-x-remix__card-loading">
            <BrandMark variant="seal" size={40} animated />
            <span>{t('create.stylePolishingStatus')}</span>
          </div>
        )}
        {creation.optimizedCaption ? (
          <div className="ai00-x-remix__accepted">
            <span className="ai00-x-remix__field-label">{t('create.styleEnTitle')}</span>
            <p className="ai00-x-remix__accepted-en">{creation.optimizedCaption}</p>
            {creation.optimizedCaptionZh && (
              <p className="ai00-x-remix__accepted-zh">{creation.optimizedCaptionZh}</p>
            )}
            <button
              type="button"
              className="ai00-x-remix__accepted-clear"
              title={t('create.clearOptimization')}
              onClick={() => clearOptimization(creationId)}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <p className="ai00-x-remix__optional-hint">{t('create.remix.styleOptionalHint')}</p>
        )}
        {optimization && (
          <div className="ai00-x-remix__optimization">
            <p className="ai00-x-remix__accepted-en">{optimization.caption}</p>
            {optimization.captionZh && <p className="ai00-x-remix__accepted-zh">{optimization.captionZh}</p>}
            <div className="ai00-x-remix__optimization-actions">
              <Button size="small" onClick={() => acceptOptimizationResult(optimization)}>
                <Check size={12} />
                {t('create.accept')}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={styleOptimizing || !lastStyleBrief.current}
                onClick={() => void handleOptimizeStyle()}
              >
                <RefreshCw size={12} />
                {t('create.retry')}
              </Button>
              <Button size="small" variant="ghost" onClick={() => setOptimization(null)}>
                <X size={12} />
                {t('create.discard')}
              </Button>
            </div>
          </div>
        )}
        {!creation.generating && (
          <div className="ai00-x-remix__style-bar">
            <ModelSelectorShared
              currentMode="music"
              controlledValue={creation.aiModel ?? null}
              onControlledSelect={(ref) => patchCreation(creationId, { aiModel: ref })}
            />
            <Textarea
              className="ai00-x-remix__style-input"
              variant="default"
              autoResize
              rows={1}
              value={styleInput}
              placeholder={t('create.remix.stylePlaceholder')}
              onChange={(e) => setStyleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void handleOptimizeStyle();
                }
              }}
            />
            <button
              type="button"
              className="ai00-x-remix__style-send"
              disabled={styleOptimizing || !styleInput.trim()}
              title={t('create.remix.styleSendHint')}
              onClick={() => void handleOptimizeStyle()}
            >
              {styleOptimizing ? <Loader2 size={14} className="ai00-x-create__spin" /> : <Sparkles size={14} />}
            </button>
          </div>
        )}
      </section>

      {/* ---- 歌词卡 ---- */}
      <section className={`ai00-x-remix__card${lyricsDisabled ? ' is-disabled' : ''}`}>
        <header className="ai00-x-remix__card-head ai00-x-remix__card-head--lyrics">
          <h3>{t('create.lyricsTitle')}</h3>
          {lyricsWriting && !lyricsStream && (
            <div className="ai00-x-remix__card-loading">
              <BrandMark variant="seal" size={32} animated />
              <span>{t('create.lyricsWritingStatus')}</span>
            </div>
          )}
          <label className="ai00-x-remix__param-toggle">
            <Switch
              size="small"
              checked={creation.params.instrumental}
              onChange={(e) => patchParams(creationId, { instrumental: e.target.checked })}
            />
            <span>{t('create.paramInstrumental')}</span>
          </label>
          <div className="ai00-x-remix__lyrics-spacer" />
          <Select
            options={templateOptions}
            value={templateId}
            onChange={(v) => applyTemplate(String(v ?? ''))}
            size="small"
            disabled={lyricsDisabled}
          />
        </header>
        {lyricsPreview && (
          <div className="ai00-x-remix__optimization">
            <span className="ai00-x-remix__field-label">{t('create.aiLyricsPreviewTitle')}</span>
            <pre className="ai00-x-remix__lyrics-preview">
              {serializeLyrics(
                lyricsPreview.segments.map((s) => ({
                  id: s.tag,
                  kind: s.tag,
                  descriptors: s.descriptors.length > 0 ? s.descriptors : undefined,
                  lines: s.lines,
                })),
              )}
            </pre>
            <div className="ai00-x-remix__optimization-actions">
              <Button size="small" onClick={acceptLyricsPreview}>
                <Check size={12} />
                {t('create.accept')}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={lyricsWriting || !lastLyricsBrief.current}
                onClick={() => void handleWriteLyrics()}
              >
                <RefreshCw size={12} />
                {t('create.retry')}
              </Button>
              <Button size="small" variant="ghost" onClick={() => setLyricsPreview(null)}>
                <X size={12} />
                {t('create.discard')}
              </Button>
            </div>
          </div>
        )}
        <div className="ai00-x-remix__lyrics-body">
          <LyricsSegmentsEditor creationId={creationId} streamingText={lyricsStream} />
        </div>
      </section>

      {/* ---- 参数 + 生成行 ---- */}
      {!creation.generating && (
        <section className="ai00-x-remix__gen-row">
          <div className="ai00-x-remix__gen-params">
            <div className="ai00-x-remix__param">
              <span>{t('create.paramLanguage')}</span>
              <Select
                options={languageOptions}
                value={creation.params.vocalLanguage || 'auto'}
                onChange={(v) => {
                  const lang = String(v ?? 'auto');
                  patchParams(creationId, { vocalLanguage: lang === 'auto' ? '' : lang });
                }}
                size="small"
                disabled={lyricsDisabled}
                placement="top"
              />
            </div>
            <div className="ai00-x-remix__param">
              <span>{t('create.genPopCount')}</span>
              <div className="ai00-x-remix__counts">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`ai00-x-remix__count${(creation.params.generateCount ?? 1) === n ? ' is-active' : ''}`}
                    disabled={creation.generating}
                    onClick={() => patchParams(creationId, { generateCount: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <ModelSelector />
          </div>
          <Button
            className="ai00-x-remix__generate"
            disabled={!canGenerate || creation.generating}
            title={
              !rp.sourcePath
                ? t('create.remix.needSource')
                : regionInvalid
                  ? t('create.remix.regionInvalid', { min: REGION_MIN_SEC, max: REGION_MAX_SEC })
                  : undefined
            }
            onClick={() => void generateRemix(creationId)}
          >
            {creation.generating ? <Loader2 size={14} className="ai00-x-create__spin" /> : <Sparkles size={14} />}
            {creation.generating
              ? generateProgress && generateProgress.total > 1
                ? t('create.generatingN', { done: generateProgress.done, total: generateProgress.total })
                : t('create.generating')
              : t('create.remix.generate')}
          </Button>
        </section>
      )}

      {/* ---- 样例组 ---- */}
      <div className="ai00-x-remix__samples">
        <header className="ai00-x-remix__samples-head">
          {t('create.samplesTitle')}
          <span className="ai00-x-remix__samples-count">{creation.samples.length}</span>
        </header>
        <div className="ai00-x-remix__samples-list">
          {creation.samples.map((sample, i) => (
            <div key={sample.id} className="ai00-x-remix__sample">
              <div className="ai00-x-remix__sample-head">
                <span className="ai00-x-remix__sample-label">
                  {t('create.sampleN', { index: i + 1 })} · {formatClock(sample.durationSeconds)}
                </span>
                <div className="ai00-x-remix__sample-actions">
                  <ScoreBadge score={sample.score} />
                  <SendToRemixButton
                    audioPath={sample.audioPath}
                    name={creation.title}
                    durationSeconds={sample.durationSeconds}
                  />
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={sample.inLibrary}
                    onClick={() => setPackagingSampleId(sample.id)}
                  >
                    <Library size={12} />
                    {sample.inLibrary ? t('create.inLibrary') : t('create.saveToLibrary')}
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => deleteSample(creationId, sample.id)}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
              <div className="ai00-x-remix__sample-player">
                <SamplePlayer
                  filePath={sample.audioPath}
                  durationSeconds={sample.durationSeconds}
                  lrc={sample.lrc}
                  fallbackLyrics={
                    creation.params.instrumental
                      ? undefined
                      : creation.lyricsSegments.flatMap((s) => s.lines).filter((l) => l.trim()).join('\n') ||
                        undefined
                  }
                  active={activeSampleId === null || activeSampleId === sample.id}
                  onActivate={() => setActiveSampleId(sample.id)}
                />
              </div>
            </div>
          ))}
          {creation.generating && (
            <div className="ai00-x-remix__sample ai00-x-remix__sample--pending">
              <Loader2 size={16} className="ai00-x-create__spin" />
              <span>
                {generateProgress && generateProgress.total > 1
                  ? t('create.generatingN', { done: generateProgress.done, total: generateProgress.total })
                  : t('create.generating')}
              </span>
            </div>
          )}
          {!creation.generating && creation.samples.length === 0 && (
            <p className="ai00-x-remix__samples-empty">{t('create.samplesEmpty')}</p>
          )}
        </div>
      </div>

      <AudioSourcePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(source) => {
          patchRemix(creationId, {
            sourcePath: source.path,
            sourceName: source.name,
            sourceDurationSec: source.durationSeconds,
          });
          setPickerOpen(false);
        }}
        title={t('create.remix.pickerTitle')}
      />
      <PackageDialog
        open={packagingSampleId !== null}
        creationId={creationId}
        sampleId={packagingSampleId}
        onClose={() => setPackagingSampleId(null)}
      />
    </div>
  );
};

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default RemixEditor;

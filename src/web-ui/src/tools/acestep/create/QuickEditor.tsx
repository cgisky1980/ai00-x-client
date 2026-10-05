/**
 * QuickEditor — 快捷创作编辑器（图 A）。
 *
 * 双卡主输入：风格描述（AI 整理优化，英文标准 caption + 中文对照）+
 * 歌词（曲式模板 + 分段编辑 + AI 写词）。参数仅时长/人声语言/纯音乐。
 * 生成结果收在本创作的样例组内，支持试听 / 存入曲库 / 换一版 / 删除。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Loader2, Library, RefreshCw, Trash2, Check, X, Mic } from 'lucide-react';
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
import { optimizeStyle, writeLyrics, classifyDirective, parseLyricsResponse } from './musicAgent';
import type { StyleOptimization, LyricsJson } from './musicAgent';
import { truncateLyricsContext } from './agentPrompts';
import { serializeLyrics } from './tagCatalog';
import { LYRIC_TEMPLATES, INSTRUMENTAL_TEMPLATE_ID, estimateDurationSec } from './lyricTemplates';
import { newId } from './types';
import PackageDialog from './PackageDialog';
import './QuickEditor.scss';

interface Props {
  creationId: string;
}



const QuickEditor: React.FC<Props> = ({ creationId }) => {
  const { t } = useI18n('acestep');
  const creation = useCreateStore((s) => s.creations.find((c) => c.id === creationId));
  const patchCreation = useCreateStore((s) => s.patchCreation);
  const patchParams = useCreateStore((s) => s.patchParams);
  const acceptOptimization = useCreateStore((s) => s.acceptStyleOptimization);
  const clearOptimization = useCreateStore((s) => s.clearStyleOptimization);
  const generateQuick = useCreateStore((s) => s.generateQuick);
  const generateProgress = useCreateStore((s) => s.generateProgress);
  const deleteSample = useCreateStore((s) => s.deleteSample);

  const [styleOptimizing, setStyleOptimizing] = useState(false);
  const [lyricsWriting, setLyricsWriting] = useState(false);
  const [optimization, setOptimization] = useState<StyleOptimization | null>(null);
  /** AI 歌词流式原文（写入中）与解析后待采纳的方案。 */
  const [lyricsStream, setLyricsStream] = useState<string | null>(null);
  const [lyricsPreview, setLyricsPreview] = useState<LyricsJson | null>(null);
  const [templateId, setTemplateId] = useState<string>(LYRIC_TEMPLATES[0].id);
  const [packagingSampleId, setPackagingSampleId] = useState<string | null>(null);
  /** 参考音色选择器开合（可选增强：生成贴合参考音频的音色质感）。 */
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  /** 正在播放的样例（卡拉OK播放器互斥：新播放自动暂停旧实例）。 */
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  // AI 指令栏（卡片区下方整行）：指令输入；目标（风格/歌词/both）恒由路由模型自动判断
  const [aiInput, setAiInput] = useState('');
  /** 正在执行的 AI 指令（显示在两张卡的加载遮罩气泡里）。 */
  const [aiInstruction, setAiInstruction] = useState('');
  /** 生成悬停外框开关（悬停生成按钮时框包裹按钮并显示模型/数量选项）。 */
  const [genPopOpen, setGenPopOpen] = useState(false);
  /** 模型下拉开合（开着时外框保持展开）。 */
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const modelPopOpenRef = useRef(false);
  const genHoverRef = useRef(false);
  const genPopCloseTimer = useRef<number | null>(null);
  const genWrapOpen = genPopOpen || modelPopOpen;
  /** 上一次风格指令（优化结果卡的「再来一版」用）。 */
  const lastStyleBrief = useRef('');
  /** 最近一次歌词指令（重试用，不依赖输入框当前内容）。 */
  const lastLyricsBrief = useRef('');


  /** 时长档位：含“按歌词自动计算”动态项（每行 ≈3s + 15s，规范公式）。 */
  const durationOptions: SelectOption[] = useMemo(() => {
    if (!creation) return [];
    const est = estimateDurationSec(creation.lyricsSegments, creation.params.instrumental);
    const m = Math.floor(est / 60);
    const s = String(est % 60).padStart(2, '0');
    return [
      { value: '0', label: t('create.durationAuto', { time: `${m}:${s}` }) },
      { value: '60', label: '1:00' },
      { value: '90', label: '1:30' },
      { value: '120', label: '2:00' },
      { value: '150', label: '2:30' },
      { value: '180', label: '3:00' },
      { value: '240', label: '4:00' },
    ];
  }, [creation, t]);

  const templateOptions: SelectOption[] = useMemo(
    () => [
      ...LYRIC_TEMPLATES.map((tpl) => ({ value: tpl.id, label: tpl.nameZh })),
      { value: INSTRUMENTAL_TEMPLATE_ID, label: t('create.templateInstrumental') },
    ],
    [t],
  );

  /** Vocal-language options: AceStep speaks zh/en/ja/ko. */
  const languageOptions: SelectOption[] = [
    { value: 'auto', label: t('create.langAuto') },
    { value: 'zh', label: t('create.langZh') },
    { value: 'en', label: t('create.langEn') },
    { value: 'ja', label: t('create.langJa') },
    { value: 'ko', label: t('create.langKo') },
  ];

  /** Apply a template: fill sections with sample lyrics the user can edit. */
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

  // 计时器清理（须在早退之前——hooks 不可条件调用）
  useEffect(() => () => {
    if (genPopCloseTimer.current !== null) window.clearTimeout(genPopCloseTimer.current);
  }, []);

  if (!creation) return null;

  const lyricsDisabled = creation.params.instrumental;
  const aiRunning = styleOptimizing || lyricsWriting;

  const aiPlaceholder = t('create.aiPlaceholderAuto');

  /** 悬停外框：进入立即展开；离开延迟 180ms 收回（跨向内层模型下拉时不闪关）。 */
  const openGenPop = () => {
    if (genPopCloseTimer.current !== null) {
      window.clearTimeout(genPopCloseTimer.current);
      genPopCloseTimer.current = null;
    }
    setGenPopOpen(true);
  };
  const scheduleGenPopClose = () => {
    if (genPopCloseTimer.current !== null) window.clearTimeout(genPopCloseTimer.current);
    genPopCloseTimer.current = window.setTimeout(() => {
      genPopCloseTimer.current = null;
      if (!modelPopOpenRef.current) setGenPopOpen(false);
    }, 180);
  };
  /** 模型下拉开合透传：开着时外框保持；关闭后鼠标不在框内则收回。 */
  const handleModelOpenChange = (o: boolean) => {
    modelPopOpenRef.current = o;
    setModelPopOpen(o);
    if (!o && !genHoverRef.current) scheduleGenPopClose();
  };

  const handleOptimizeStyle = async (direction: string) => {
    if (styleOptimizing) return;
    setStyleOptimizing(true);
    try {
      // 附上完整歌词（含结构标签，生成请求同款序列化）供风格意境参考；行边界截断保护
      const lyricsContext = truncateLyricsContext(
        serializeLyrics(creation.lyricsSegments.filter((s) => s.lines.length > 0)),
      );
      const result = await optimizeStyle({
        brief: direction.trim(),
        lyricsContext: lyricsDisabled ? undefined : lyricsContext || undefined,
        instrumental: lyricsDisabled,
        model: creation.aiModel ?? undefined,
      });
      setOptimization(result);
      lastStyleBrief.current = direction.trim();
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

  /** 歌词目标：已有歌词 → 按指令改写；没有 → 按模板结构创作。流式原文进编辑器预览，完成后出「预览→采纳」卡。 */
  const handleWriteLyrics = async (instruction: string) => {
    if (lyricsWriting) return;
    lastLyricsBrief.current = instruction.trim();
    setLyricsWriting(true);
    setLyricsStream('');
    try {
      const existing = serializeLyrics(creation.lyricsSegments.filter((s) => s.lines.length > 0));
      const tpl = LYRIC_TEMPLATES.find((x) => x.id === templateId);
      const text = await writeLyrics({
        theme: instruction.trim(),
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

  /** 采纳 AI 歌词方案：写入分段编辑器并清场。 */
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
    setAiInput('');
    toastSuccess(t('create.aiLyricsApplied'));
  };

  /** AI 指令栏入口：点发即清空输入（指令存入 aiInstruction 供遮罩气泡展示）；路由自动判定目标；both = 双改并行。 */
  const handleAiRun = async () => {
    const instruction = aiInput.trim();
    if (!instruction || aiRunning) return;
    setAiInstruction(instruction);
    setAiInput('');
    let mode: 'style' | 'lyrics' | 'both' = await classifyDirective({
      instruction,
      model: creation.aiModel ?? undefined,
    });
    if (mode !== 'style' && lyricsDisabled) mode = 'style'; // 纯音乐：无歌词可改
    if (mode === 'both') {
      await Promise.all([handleOptimizeStyle(instruction), handleWriteLyrics(instruction)]);
    } else if (mode === 'lyrics') {
      await handleWriteLyrics(instruction);
    } else {
      await handleOptimizeStyle(instruction);
    }
  };

  const acceptOptimizationResult = (opt: StyleOptimization) => {
    acceptOptimization(creationId, opt.caption, opt.captionZh, opt.duration);
    if (!creation.params.instrumental && ['zh', 'en', 'ja', 'ko'].includes(opt.vocal_language)) {
      patchParams(creationId, { vocalLanguage: opt.vocal_language });
    }
    setOptimization(null);
    setAiInput('');
  };

  return (
    <div className="ai00-x-quick">
      <div className="ai00-x-quick__cards">
        {/* ---- 风格卡 ---- */}
        <section className="ai00-x-quick__card">
          <header className="ai00-x-quick__card-head">
            <h3>{t('create.styleTitle')}</h3>
          </header>
          {styleOptimizing && (
            <div className="ai00-x-quick__card-loading">
              <BrandMark variant="seal" size={40} animated />
              {aiInstruction && (
                <div className="ai00-x-quick__card-loading-bubble">「{aiInstruction}」</div>
              )}
              <span>{t('create.stylePolishingStatus')}</span>
            </div>
          )}

          {/* 英文提示词（送模型推理的权威内容，AI 润色产物） */}
          {creation.optimizedCaption ? (
            <div className="ai00-x-quick__accepted">
              <span className="ai00-x-quick__field-label">{t('create.styleEnTitle')}</span>
              <p className="ai00-x-quick__accepted-en">{creation.optimizedCaption}</p>
              {creation.optimizedCaptionZh && (
                <p className="ai00-x-quick__accepted-zh">{creation.optimizedCaptionZh}</p>
              )}
              <button
                type="button"
                className="ai00-x-quick__accepted-clear"
                title={t('create.clearOptimization')}
                onClick={() => clearOptimization(creationId)}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <p className="ai00-x-quick__need-optimize">{t('create.needOptimizeHint')}</p>
          )}


          {/* 风格相关参数卡：时长 / 人声语言；AI 指令栏已下移到整行卡片 */}
          <div className="ai00-x-quick__style-params">
            <div className="ai00-x-quick__param">
              <span>{t('create.paramDuration')}</span>
              <Select
                options={durationOptions}
                value={String(creation.params.durationSec)}
                onChange={(v) => patchParams(creationId, { durationSec: Number(v ?? 0) })}
                size="small"
                placement="top"
              />
            </div>
            <div className="ai00-x-quick__param">
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
          </div>

          {/* 参考音色槽（可选）：上传/录音/收藏/作品任选，引擎按其音色质感做条件生成 */}
          <div className="ai00-x-quick__ref-audio">
            {creation.params.refAudioPath ? (
              <div className="ai00-x-quick__ref-picked">
                <Mic size={13} />
                <span className="ai00-x-quick__ref-name">
                  {creation.params.refAudioName || creation.params.refAudioPath}
                </span>
                <span className="ai00-x-quick__ref-hint">{t('create.refAudio.hint')}</span>
                <button
                  type="button"
                  className="ai00-x-quick__ref-clear"
                  title={t('create.refAudio.clear')}
                  onClick={() => patchParams(creationId, { refAudioPath: undefined, refAudioName: undefined })}
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ai00-x-quick__ref-add"
                onClick={() => setRefPickerOpen(true)}
              >
                <Mic size={12} />
                {t('create.refAudio.add')}
              </button>
            )}
          </div>

          {optimization && (
            <div className="ai00-x-quick__optimization">
              <p className="ai00-x-quick__accepted-en">{optimization.caption}</p>
              {optimization.captionZh && <p className="ai00-x-quick__accepted-zh">{optimization.captionZh}</p>}
              <div className="ai00-x-quick__opt-params">
                <span className="ai00-x-quick__opt-params-label">{t('create.suggestParams')}</span>
                {optimization.bpm > 0 && <span>BPM {optimization.bpm}</span>}
                {optimization.keyscale && <span>{optimization.keyscale}</span>}
                {optimization.timesignature && <span>{optimization.timesignature}</span>}
                {optimization.duration > 0 && <span>≈{formatDuration(optimization.duration)}</span>}
                {optimization.vocal_language && <span>{optimization.vocal_language}</span>}
              </div>
              {optimization.reasoning && <p className="ai00-x-quick__opt-reason">{optimization.reasoning}</p>}
              <div className="ai00-x-quick__optimization-actions">
                <Button size="small" onClick={() => acceptOptimizationResult(optimization)}>
                  <Check size={12} />
                  {t('create.accept')}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={styleOptimizing || !lastStyleBrief.current}
                  onClick={() => void handleOptimizeStyle(lastStyleBrief.current)}
                >
                  <RefreshCw size={12} />
                  {t('create.retry')}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    setOptimization(null);
                    setAiInput('');
                  }}
                >
                  <X size={12} />
                  {t('create.discard')}
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* ---- 歌词卡：头一行 = 标题 + 纯音开关 + 模板下拉 ---- */}
        <section className={`ai00-x-quick__card${lyricsDisabled ? ' is-disabled' : ''}`}>
          <header className="ai00-x-quick__card-head ai00-x-quick__card-head--lyrics">
            <h3>{t('create.lyricsTitle')}</h3>
            {/* AI 写词遮罩：首 token 到达前的加载反馈（到达后让位给编辑器流式预览） */}
            {lyricsWriting && !lyricsStream && (
              <div className="ai00-x-quick__card-loading">
                <BrandMark variant="seal" size={40} animated />
                {aiInstruction && (
                  <div className="ai00-x-quick__card-loading-bubble">「{aiInstruction}」</div>
                )}
                <span>{t('create.lyricsWritingStatus')}</span>
              </div>
            )}
            <label className="ai00-x-quick__param ai00-x-quick__param--toggle">
              <Switch
                size="small"
                checked={creation.params.instrumental}
                onChange={(e) => patchParams(creationId, { instrumental: e.target.checked })}
              />
              <span>{t('create.paramInstrumental')}</span>
            </label>
            <div className="ai00-x-quick__lyrics-spacer" />
            <Select
              options={templateOptions}
              value={templateId}
              onChange={(v) => applyTemplate(String(v ?? ''))}
              size="small"
              disabled={lyricsDisabled}
            />
          </header>
          {lyricsPreview && (
            <div className="ai00-x-quick__optimization">
              <span className="ai00-x-quick__field-label">{t('create.aiLyricsPreviewTitle')}</span>
              <pre className="ai00-x-quick__lyrics-preview">
                {serializeLyrics(
                  lyricsPreview.segments.map((s) => ({
                    id: s.tag,
                    kind: s.tag,
                    descriptors: s.descriptors.length > 0 ? s.descriptors : undefined,
                    lines: s.lines,
                  })),
                )}
              </pre>
              <div className="ai00-x-quick__optimization-actions">
                <Button size="small" onClick={acceptLyricsPreview}>
                  <Check size={12} />
                  {t('create.accept')}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={lyricsWriting || !lastLyricsBrief.current}
                  onClick={() => {
                    setLyricsPreview(null);
                    void handleWriteLyrics(lastLyricsBrief.current);
                  }}
                >
                  <RefreshCw size={12} />
                  {t('create.retry')}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    setLyricsPreview(null);
                    setAiInput('');
                  }}
                >
                  <X size={12} />
                  {t('create.discard')}
                </Button>
              </div>
            </div>
          )}
          <div className="ai00-x-quick__lyrics-body">
            <LyricsSegmentsEditor creationId={creationId} streamingText={lyricsStream} />
          </div>
        </section>
      </div>

      {/* ---- AI 指令栏（整行）：输入框（吃满剩余，初始 2 行扩到 3 行向上浮层化）+ 生成按钮（悬停外框） ---- */}
      {/* 生成歌曲期间整行隐藏（AI 输入/生成按钮与生成态无关，忙态遮罩只留灵印与进度） */}
      {!creation.generating && (
      <section className="ai00-x-quick__ai-bar">
        {/* 恒定占位：撑起 ai 行高度（2 行场高），输入框向上生长时不顶开布局 */}
        <div className="ai00-x-quick__ai-field-space" />
        <div className="ai00-x-quick__ai-field">
          <div className="ai00-x-quick__ai-field-model">
            <ModelSelectorShared
              currentMode="music"
              controlledValue={creation.aiModel ?? null}
              onControlledSelect={(ref) => patchCreation(creationId, { aiModel: ref })}
            />
          </div>
          {/* 多行指令：初始 1 行自动扩到 3 行，超出滚动；Enter=换行，Ctrl+Enter=发送 */}
          <Textarea
            className="ai00-x-quick__ai-input"
            variant="default"
            autoResize
            rows={1}
            value={aiInput}
            placeholder={aiPlaceholder}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleAiRun();
              }
            }}
          />
          <button
            type="button"
            className="ai00-x-quick__ai-send"
            disabled={aiRunning || !aiInput.trim()}
            title={t('create.aiSendHint')}
            onClick={() => void handleAiRun()}
          >
            {aiRunning ? <Loader2 size={14} className="ai00-x-create__spin" /> : <Sparkles size={14} />}
          </button>
        </div>

        {/* 生成：悬停时外框包裹按钮，框内上方展开模型/数量两行选项 */}
        <div
          className={`ai00-x-quick__ai-gen-wrap${genWrapOpen ? ' is-open' : ''}`}
          onMouseEnter={() => {
            genHoverRef.current = true;
            openGenPop();
          }}
          onMouseLeave={() => {
            genHoverRef.current = false;
            scheduleGenPopClose();
          }}
        >
          <div className="ai00-x-quick__ai-gen-options">
            <div className="ai00-x-quick__ai-gen-row">
              <span>{t('create.genPopEngine')}</span>
              <ModelSelector onOpenChange={handleModelOpenChange} />
            </div>
            <div className="ai00-x-quick__ai-gen-row">
              <span>{t('create.genPopCount')}</span>
              <div className="ai00-x-quick__ai-gen-counts">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`ai00-x-quick__ai-gen-count${
                      (creation.params.generateCount ?? 1) === n ? ' is-active' : ''
                    }`}
                    disabled={creation.generating}
                    onClick={() => patchParams(creationId, { generateCount: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Button
            className="ai00-x-quick__ai-gen"
            disabled={creation.generating || !creation.optimizedCaption}
            title={creation.optimizedCaption ? undefined : t('create.generateNeedOptimize')}
            onClick={() => void generateQuick(creationId)}
          >
            {creation.generating ? <Loader2 size={14} className="ai00-x-create__spin" /> : <Sparkles size={14} />}
            {creation.generating
              ? generateProgress && generateProgress.total > 1
                ? t('create.generatingN', { done: generateProgress.done, total: generateProgress.total })
                : t('create.generating')
              : t('create.generate')}
          </Button>
        </div>
      </section>
      )}

      {/* ---- 样例组：右侧整列，样例卡片竖排 ---- */}
      <div className="ai00-x-quick__samples">
        <header className="ai00-x-quick__samples-head">
          {t('create.samplesTitle')}
          <span className="ai00-x-quick__samples-count">{creation.samples.length}</span>
        </header>
        <div className="ai00-x-quick__samples-list">
        {creation.samples.map((sample, i) => (
          <div key={sample.id} className="ai00-x-quick__sample">
            <div className="ai00-x-quick__sample-head">
              <span className="ai00-x-quick__sample-label">
                {t('create.sampleN', { index: i + 1 })} · {formatDuration(sample.durationSeconds)}
              </span>
              <div className="ai00-x-quick__sample-actions">
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
            <div className="ai00-x-quick__sample-player">
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
          <div className="ai00-x-quick__sample ai00-x-quick__sample--pending">
            <Loader2 size={16} className="ai00-x-create__spin" />
            <span>
              {generateProgress && generateProgress.total > 1
                ? t('create.generatingN', { done: generateProgress.done, total: generateProgress.total })
                : t('create.generating')}
            </span>
          </div>
        )}
        {!creation.generating && creation.samples.length === 0 && (
          <p className="ai00-x-quick__samples-empty">{t('create.samplesEmpty')}</p>
        )}
        </div>
      </div>

      {/* ---- 打包发行弹窗 ---- */}
      <PackageDialog
        open={packagingSampleId !== null}
        creationId={creationId}
        sampleId={packagingSampleId}
        onClose={() => setPackagingSampleId(null)}
      />

      {/* ---- 参考音色选择器 ---- */}
      <AudioSourcePicker
        open={refPickerOpen}
        onClose={() => setRefPickerOpen(false)}
        onPick={(source) => {
          patchParams(creationId, { refAudioPath: source.path, refAudioName: source.name });
          setRefPickerOpen(false);
        }}
        title={t('create.refAudio.pickerTitle')}
      />
    </div>
  );
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default QuickEditor;

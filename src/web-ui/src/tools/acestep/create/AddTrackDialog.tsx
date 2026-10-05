/**
 * AddTrackDialog — 添加音轨弹层。
 * 类型 chips（鼓/贝斯/人声/和声/旋律/自定义）+ 该轨描述 +
 * （人声/和声时）歌词与语言 → 生成此轨。
 */

import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Button, Modal, Select, Textarea } from '@/component-library';
import type { SelectOption } from '@/component-library';
import { useCreateStore } from './createStore';
import { parseLyricsText, serializeLyrics } from './tagCatalog';
import type { TrackKind } from './types';
import './CreateEditors.scss';

interface Props {
  open: boolean;
  creationId: string;
  onClose: () => void;
}

interface KindMeta {
  kind: TrackKind;
  labelKey: string;
  /** Default prompt template (locale-resolved at render). */
  promptKey: string;
  vocal: boolean;
}

const KINDS: KindMeta[] = [
  { kind: 'drums', labelKey: 'kindDrums', promptKey: 'promptDrums', vocal: false },
  { kind: 'bass', labelKey: 'kindBass', promptKey: 'promptBass', vocal: false },
  { kind: 'vocals', labelKey: 'kindVocals', promptKey: 'promptVocals', vocal: true },
  { kind: 'harmony', labelKey: 'kindHarmony', promptKey: 'promptHarmony', vocal: true },
  { kind: 'melody', labelKey: 'kindMelody', promptKey: 'promptMelody', vocal: false },
  { kind: 'custom', labelKey: 'kindCustom', promptKey: 'promptCustom', vocal: false },
];

const AddTrackDialog: React.FC<Props> = ({ open, creationId, onClose }) => {
  const { t } = useI18n('acestep');
  const addTrack = useCreateStore((s) => s.addTrack);
  const generateTrack = useCreateStore((s) => s.generateTrack);
  const busy = useCreateStore((s) => s.generatingTrackId !== null);

  const [kind, setKind] = useState<TrackKind>('drums');
  const [prompt, setPrompt] = useState('');
  const [lyricsText, setLyricsText] = useState('');
  const [lang, setLang] = useState('zh');

  const meta = KINDS.find((k) => k.kind === kind) ?? KINDS[0];

  useEffect(() => {
    if (open) {
      setPrompt(t(meta.promptKey));
      setLyricsText('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const langOptions: SelectOption[] = [
    { value: 'zh', label: t('create.langZh') },
    { value: 'en', label: t('create.langEn') },
    { value: 'ja', label: t('create.langJa') },
    { value: 'ko', label: t('create.langKo') },
  ];

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    const trackId = await addTrack(
      creationId,
      kind,
      t(`trackEditor.${meta.labelKey}`),
      prompt.trim(),
      meta.vocal && lyricsText.trim()
        ? serializeLyrics(
            parseLyricsText(lyricsText).map((b) => ({
              kind: b.tag,
              descriptors: b.descriptors.slice(0, 2),
              lines: b.lines,
            })),
          )
        : undefined,
      meta.vocal ? lang : undefined,
    );
    onClose();
    await generateTrack(creationId, trackId);
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t('trackEditor.addTrack')}>
      <div className="ai00-x-addtrack">
        <div className="ai00-x-addtrack__kinds">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`ai00-x-addtrack__kind${k.kind === kind ? ' is-active' : ''}`}
              onClick={() => setKind(k.kind)}
            >
              {t(`trackEditor.${k.labelKey}`)}
            </button>
          ))}
        </div>

        <div className="ai00-x-addtrack__field">
          <span>{t('trackEditor.trackPrompt')}</span>
          <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </div>

        {meta.vocal && (
          <div className="ai00-x-addtrack__field">
            <span>{t('create.lyricsTitle')}</span>
            <Textarea
              rows={5}
              value={lyricsText}
              placeholder={t('trackEditor.trackLyricsPlaceholder')}
              onChange={(e) => setLyricsText(e.target.value)}
            />
            <div className="ai00-x-addtrack__field-row">
              <span>{t('create.paramLanguage')}</span>
              <Select options={langOptions} value={lang} onChange={(v) => setLang(String(v ?? 'zh'))} size="small" />
            </div>
          </div>
        )}

        <div className="ai00-x-addtrack__actions">
          <Button size="small" variant="ghost" onClick={onClose}>
            {t('create.cancel')}
          </Button>
          <Button size="small" disabled={!prompt.trim() || busy} onClick={() => void submit()}>
            {busy ? t('create.generating') : t('trackEditor.generateTrack')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default AddTrackDialog;

/**
 * 皮肤编辑器（规范 v1.0 第四节）：调种子色 → 界面实时预览 → 对比度体检通过才可保存。
 * 一份皮肤 = 暗色 + 亮色两档种子 + 字体 + 圆角/按钮/动效档；其余 token 全部自动派生。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal } from '@/component-library';
import { themeService } from '@/infrastructure/theme';
import {
  BUTTON_SHAPES,
  checkSkin,
  FONT_CATALOG,
  MOTION_LEVELS,
  OPTIONAL_SEEDS,
  RADIUS_PRESETS,
  REQUIRED_SEEDS,
  completeSeeds,
  type FontId,
  type SeedKey,
  type Skin,
  type SkinMode,
} from '@ai00-x/design-system/skin';

const SEED_LABEL: Record<SeedKey, string> = {
  bg: '底色',
  surface: '面板',
  ink: '正文',
  muted: '次要文字',
  accent: '交互色',
  accentInk: '交互色上的字',
  mark: '高亮笔',
  markInk: '高亮笔上的字',
  success: '成功',
  warning: '警告',
  error: '错误',
  info: '提示',
};
const RADIUS_LABEL = { sharp: '利落', soft: '柔和', round: '圆润' } as const;
const BUTTON_LABEL = { solid: '实心', pill: '药丸', tonal: '浅底' } as const;
const MOTION_LABEL = { full: '完整', reduced: '只变色' } as const;

export interface SkinEditorProps {
  /** 以此为起点（内置皮肤会被复制为新 id） */
  base: Skin;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (skin: Skin) => void;
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length >= 2 ? s.slice(0, 40) : `skin-${Date.now().toString(36)}`;
}

export function SkinEditor({ base, isOpen, onClose, onSaved }: SkinEditorProps) {
  const { t } = useTranslation('settings/basics');
  const forking = themeService.isBuiltinSkin(base.id);
  const [draft, setDraft] = useState<Skin>(() => fork(base, forking));
  const [mode, setMode] = useState<SkinMode>(() =>
    themeService.getResolvedThemeId() === 'ai00-x-light' ? 'light' : 'dark',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setDraft(fork(base, forking));
      setError(null);
    }
  }, [isOpen, base, forking]);

  // 实时预览：编辑期间整个界面套用草稿；关闭即恢复
  useEffect(() => {
    if (!isOpen) return;
    themeService.previewSkin(draft);
    return () => themeService.previewSkin(null);
  }, [isOpen, draft]);

  // 编辑的档跟着界面明暗走，便于所见即所得
  useEffect(() => {
    if (!isOpen) return;
    const off = themeService.on('theme:after-change', (e) => setMode(e.theme?.type === 'light' ? 'light' : 'dark'));
    return off;
  }, [isOpen]);

  const issues = useMemo(() => checkSkin(draft), [draft]);
  const errors = issues.filter((i) => i.level === 'error');
  const seeds = completeSeeds(draft.modes[mode], mode);

  const setSeed = (key: SeedKey, value: string) =>
    setDraft((d) => ({ ...d, modes: { ...d.modes, [mode]: { ...d.modes[mode], [key]: value } } }));
  const patch = (p: Partial<Skin>) => setDraft((d) => ({ ...d, ...p }));

  const switchMode = async (next: SkinMode) => {
    setMode(next);
    await themeService.applyTheme(next === 'light' ? 'ai00-x-light' : 'ai00-x-dark');
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await themeService.saveUserSkin(draft);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={forking ? t('skins.editor.newTitle', { defaultValue: '新建皮肤' }) : t('skins.editor.editTitle', { defaultValue: '编辑皮肤' })}
      size="large"
      closeOnOverlayClick={false}
    >
      <div className="skin-editor">
        <div className="skin-editor__meta">
          <Input
            label={t('skins.editor.name', { defaultValue: '名称' })}
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value, id: forking ? slug(e.target.value) : draft.id })}
          />
          <Input
            label={t('skins.editor.author', { defaultValue: '作者' })}
            value={draft.author ?? ''}
            onChange={(e) => patch({ author: e.target.value || undefined })}
          />
        </div>

        <div className="skin-editor__modes" role="tablist" aria-label={t('skins.editor.mode', { defaultValue: '明暗档' })}>
          {(['dark', 'light'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`skin-editor__mode${mode === m ? ' is-active' : ''}`}
              onClick={() => void switchMode(m)}
            >
              {m === 'dark' ? t('appearance.darkMode') : t('appearance.lightMode')}
              {issues.some((i) => i.mode === m && i.level === 'error') ? <span className="skin-editor__dot" aria-hidden /> : null}
            </button>
          ))}
        </div>

        <div className="skin-editor__seeds">
          {[...REQUIRED_SEEDS, ...OPTIONAL_SEEDS].map((key) => (
            <label key={key} className="skin-editor__seed">
              <input
                type="color"
                value={seeds[key]}
                onChange={(e) => setSeed(key, e.target.value)}
                aria-label={SEED_LABEL[key]}
              />
              <span className="skin-editor__seed-label">{SEED_LABEL[key]}</span>
              <span className="skin-editor__seed-hex">{seeds[key]}</span>
            </label>
          ))}
        </div>

        <div className="skin-editor__shape">
          <Segmented
            label={t('skins.editor.radius', { defaultValue: '圆角' })}
            value={draft.shape.radius}
            options={Object.keys(RADIUS_PRESETS) as Array<keyof typeof RADIUS_PRESETS>}
            labels={RADIUS_LABEL}
            onChange={(radius) => patch({ shape: { ...draft.shape, radius } })}
          />
          <Segmented
            label={t('skins.editor.buttons', { defaultValue: '按钮' })}
            value={draft.shape.buttons}
            options={[...BUTTON_SHAPES]}
            labels={BUTTON_LABEL}
            onChange={(buttons) => patch({ shape: { ...draft.shape, buttons } })}
          />
          <Segmented
            label={t('skins.editor.motion', { defaultValue: '动效' })}
            value={draft.motion}
            options={[...MOTION_LEVELS]}
            labels={MOTION_LABEL}
            onChange={(motion) => patch({ motion })}
          />
          {(['display', 'text', 'mono'] as const).map((k) => (
            <Segmented
              key={k}
              label={{ display: '标题字体', text: '正文字体', mono: '等宽字体' }[k]}
              value={draft.type[k]}
              options={(Object.keys(FONT_CATALOG) as FontId[]).filter((id) =>
                k === 'mono' ? FONT_CATALOG[id].role === 'mono' : FONT_CATALOG[id].role !== 'mono',
              )}
              labels={Object.fromEntries(Object.entries(FONT_CATALOG).map(([id, f]) => [id, f.name])) as Record<FontId, string>}
              onChange={(v) => patch({ type: { ...draft.type, [k]: v } })}
            />
          ))}
        </div>

        <ul className="skin-editor__issues" aria-live="polite">
          {issues.length === 0 ? (
            <li className="skin-editor__issue skin-editor__issue--ok">{t('skins.editor.ok', { defaultValue: '两档对比度全部合格' })}</li>
          ) : (
            issues.map((i) => (
              <li key={`${i.mode}-${i.label}`} className={`skin-editor__issue skin-editor__issue--${i.level}`}>
                {i.mode === 'dark' ? t('appearance.darkMode') : t('appearance.lightMode')} · {i.label}{' '}
                <span className="skin-editor__ratio">{i.ratio.toFixed(2)} / {i.min}</span>
              </li>
            ))
          )}
        </ul>
        {error ? <p className="skin-editor__error">{error}</p> : null}

        <div className="skin-editor__actions">
          <Button variant="ghost" onClick={onClose}>
            {t('skins.editor.cancel', { defaultValue: '取消' })}
          </Button>
          <Button variant="primary" disabled={errors.length > 0 || !draft.name.trim()} isLoading={saving} onClick={() => void save()}>
            {t('skins.editor.save', { defaultValue: '保存皮肤' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function fork(base: Skin, asNew: boolean): Skin {
  const copy: Skin = JSON.parse(JSON.stringify(base));
  if (!asNew) return copy;
  return {
    ...copy,
    id: `${base.id}-copy-${Date.now().toString(36).slice(-4)}`,
    name: `${base.name}（我的）`,
    source: `基于 ${base.id}`,
    author: undefined,
  };
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}

function Segmented<T extends string>({ label, value, options, labels, onChange }: SegmentedProps<T>) {
  return (
    <div className="skin-editor__segmented" role="radiogroup" aria-label={label}>
      <span className="skin-editor__segmented-label">{label}</span>
      <div className="skin-editor__segmented-options">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            className={`skin-editor__option${value === o ? ' is-active' : ''}`}
            onClick={() => onChange(o)}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

export default SkinEditor;

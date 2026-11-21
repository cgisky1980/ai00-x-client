/**
 * 皮肤画廊（设置 · 外观）：选皮肤 / 新建（从任意皮肤复制）/ 编辑 / 导入 / 导出 / 删除。
 * 每张卡片用该皮肤自己的种子画色块，所见即所得。
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { Button, IconButton } from '@/component-library';
import { themeService, useTheme } from '@/infrastructure/theme';
import { completeSeeds, parseSkin, type Skin } from '@ai00-x/design-system/skin';
import { SkinEditor } from './SkinEditor';

export function SkinGallery() {
  const { t } = useTranslation('settings/basics');
  const { skinId, skins, setSkin, isLight, refreshThemes } = useTheme();
  const [editing, setEditing] = useState<Skin | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = isLight ? 'light' : 'dark';

  const exportSkin = (skin: Skin) => {
    const blob = new Blob([themeService.exportSkin(skin.id)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${skin.id}.ai00skin.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importSkin = async (file: File) => {
    setMessage(null);
    const { skin, errors } = parseSkin(await file.text());
    if (!skin) {
      setMessage(errors.join('；'));
      return;
    }
    try {
      const saved = await themeService.saveUserSkin(
        themeService.isBuiltinSkin(skin.id) ? { ...skin, id: `${skin.id}-imported` } : skin,
      );
      await setSkin(saved.id);
      setMessage(t('skins.imported', { defaultValue: '已导入「{{name}}」', name: saved.name }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (skin: Skin) => {
    await themeService.deleteUserSkin(skin.id);
    refreshThemes();
  };

  return (
    <div className="skin-gallery">
      <div className="skin-gallery__grid" role="radiogroup" aria-label={t('skins.title', { defaultValue: '界面皮肤' })}>
        {skins.map((skin) => {
          const s = completeSeeds(skin.modes[mode], mode);
          const builtin = themeService.isBuiltinSkin(skin.id);
          const active = skin.id === skinId;
          return (
            <div key={skin.id} className={`skin-gallery__card${active ? ' is-active' : ''}`}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                className="skin-gallery__pick"
                onClick={() => void setSkin(skin.id)}
              >
                <span className="skin-gallery__swatch" style={{ backgroundColor: s.bg, color: s.ink }} aria-hidden>
                  <span className="skin-gallery__swatch-panel" style={{ backgroundColor: s.surface }}>
                    <span className="skin-gallery__swatch-line" style={{ backgroundColor: s.ink }} />
                    <span className="skin-gallery__swatch-line skin-gallery__swatch-line--short" style={{ backgroundColor: s.muted }} />
                  </span>
                  <span className="skin-gallery__swatch-button" style={{ backgroundColor: s.accent, color: s.accentInk }}>
                    Aa
                  </span>
                  <span className="skin-gallery__swatch-mark" style={{ backgroundColor: s.mark }} />
                </span>
                <span className="skin-gallery__name">
                  {active ? <Check size={14} aria-hidden /> : null}
                  {skin.name}
                </span>
                <span className="skin-gallery__by">{builtin ? t('skins.builtin', { defaultValue: '内置' }) : skin.author || t('skins.mine', { defaultValue: '我的' })}</span>
              </button>
              <div className="skin-gallery__tools">
                <IconButton size="small" variant="ghost" tooltip={builtin ? t('skins.fork', { defaultValue: '以此为底新建' }) : t('skins.edit', { defaultValue: '编辑' })} onClick={() => setEditing(skin)}>
                  {builtin ? <Plus size={14} /> : <Pencil size={14} />}
                </IconButton>
                <IconButton size="small" variant="ghost" tooltip={t('skins.export', { defaultValue: '导出' })} onClick={() => exportSkin(skin)}>
                  <Download size={14} />
                </IconButton>
                {!builtin ? (
                  <IconButton size="small" variant="ghost" tooltip={t('skins.delete', { defaultValue: '删除' })} onClick={() => void remove(skin)}>
                    <Trash2 size={14} />
                  </IconButton>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="skin-gallery__actions">
        <Button variant="secondary" size="small" onClick={() => setEditing(themeService.getSkin())}>
          <Plus size={14} />
          {t('skins.new', { defaultValue: '新建皮肤' })}
        </Button>
        <Button variant="ghost" size="small" onClick={() => fileRef.current?.click()}>
          <Upload size={14} />
          {t('skins.import', { defaultValue: '导入 .ai00skin.json' })}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importSkin(f);
          }}
        />
        {message ? <span className="skin-gallery__message" role="status">{message}</span> : null}
      </div>

      {editing ? (
        <SkinEditor
          base={editing}
          isOpen
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            void setSkin(saved.id);
          }}
        />
      ) : null}
    </div>
  );
}

export default SkinGallery;

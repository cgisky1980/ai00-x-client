/**
 * ThemeShop — 主题商店 v1（P2C：官方货架，积分交易）
 *
 * 主题预览卡 = 用真实 token 渲染的缩微主页样张（hero 缩微）；
 * 免费 → 直接获取；定价 → 积分购买确认（余额不足引导积分中心）；
 * 已拥有 → 应用；使用中 → 标记。购买走 store.acquireTheme（服务端 consume_credits）。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Modal, toastError, toastSuccess } from '@/component-library';
import { Check, Coins, Sparkles } from 'lucide-react';
import { type ProfileThemeDTO } from './communityApi';
import { useCommunityStore } from './communityStore';
import { textureImage, textureSize, themeVars, type ProfileTheme } from './themes';

/** DTO → 引擎主题（缺省兜底同 ProfileView） */
function toTheme(dto: ProfileThemeDTO): ProfileTheme {
  return {
    slug: dto.slug,
    name: dto.name,
    layout: dto.layout,
    price_credits: dto.price_credits,
    owned: dto.owned,
    applied: dto.applied,
    payload: {
      bg: String(dto.payload.bg ?? '#242729'),
      surface: String(dto.payload.surface ?? '#2b2f33'),
      text: String(dto.payload.text ?? '#f0f2f4'),
      textMuted: String(dto.payload.textMuted ?? '#9aa3ab'),
      border: String(dto.payload.border ?? '#3a4046'),
      borderStyle: String(dto.payload.borderStyle ?? 'solid'),
      accent: String(dto.payload.accent ?? '#60a5fa'),
      accentText: String(dto.payload.accentText ?? '#0b1220'),
      bannerBg: String(dto.payload.bannerBg ?? '#1c2023'),
      bannerOverlay: Number(dto.payload.bannerOverlay ?? 0.35),
      fontDisplay: dto.payload.fontDisplay === 'sans' ? 'sans' : 'serif',
      radius: String(dto.payload.radius ?? 'base'),
      texture: String(dto.payload.texture ?? 'grain'),
      decoration: String(dto.payload.decoration ?? 'none'),
      monoData: dto.payload.monoData !== false,
    },
  };
}

/** 缩微样张（hero 骨架的迷你版，仅展示气质） */
const ThemePreview: React.FC<{ theme: ProfileTheme }> = ({ theme }) => (
  <div
    className="community-shop__preview"
    style={{
      ...themeVars(theme),
      backgroundImage: textureImage(theme.payload),
      backgroundSize: textureSize(theme.payload),
    }}
  >
    <div className="community-shop__preview-banner" />
    <div className="community-shop__preview-avatar" />
    <div className="community-shop__preview-name">{theme.name}</div>
    <div className="community-shop__preview-line" />
    <div className="community-shop__preview-line community-shop__preview-line--short" />
    <div className="community-shop__preview-accent" />
  </div>
);

export const ThemeShop: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18n();
  const themesDTO = useCommunityStore((s) => s.themes);
  const loadThemes = useCommunityStore((s) => s.loadThemes);
  const acquireTheme = useCommunityStore((s) => s.acquireTheme);
  const applyTheme = useCommunityStore((s) => s.applyTheme);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setLoading(true);
      await loadThemes(true);
      setLoading(false);
    })();
  }, [open, loadThemes]);

  const themes = (themesDTO ?? []).map(toTheme);

  const onAcquire = async (theme: ProfileTheme) => {
    setBusy(theme.slug);
    const ok = await acquireTheme(theme.slug);
    setBusy(null);
    if (ok) {
      toastSuccess(t('themeAcquired', { defaultValue: '主题已获取' }));
    } else {
      toastError(
        useCommunityStore.getState().error ??
          t('themeAcquireFailed', { defaultValue: '获取失败，积分可能不足' }),
      );
    }
  };

  const onApply = async (theme: ProfileTheme) => {
    setBusy(theme.slug);
    const ok = await applyTheme(theme.slug);
    setBusy(null);
    if (ok) toastSuccess(t('themeApplied', { defaultValue: '主题已应用' }));
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t('shopTitle', { defaultValue: '主题商店' })} size="large">
      {loading && themes.length === 0 ? (
        <div className="community-shop__loading ds-data" aria-busy>
          …
        </div>
      ) : (
        <div className="community-shop__grid">
          {themes.map((theme) => (
            <div key={theme.slug} className="community-shop__card">
              <ThemePreview theme={theme} />
              <div className="community-shop__card-body">
                <div className="community-shop__card-head">
                  <span className="community-shop__card-name">{theme.name}</span>
                  <span className="community-shop__card-price ds-data">
                    {theme.price_credits === 0 ? (
                      t('free', { defaultValue: '免费' })
                    ) : (
                      <>
                        <Coins size={12} aria-hidden /> {theme.price_credits}
                      </>
                    )}
                  </span>
                </div>
                {theme.applied ? (
                  <Button variant="ghost" size="small" disabled>
                    <Check size={14} aria-hidden />
                    {t('inUse', { defaultValue: '使用中' })}
                  </Button>
                ) : theme.owned ? (
                  <Button
                    variant="primary"
                    size="small"
                    isLoading={busy === theme.slug}
                    onClick={() => void onApply(theme)}
                  >
                    {t('apply', { defaultValue: '应用' })}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="small"
                    isLoading={busy === theme.slug}
                    onClick={() => void onAcquire(theme)}
                  >
                    <Sparkles size={14} aria-hidden />
                    {theme.price_credits === 0
                      ? t('acquireFree', { defaultValue: '获取' })
                      : t('buy', { defaultValue: '购买' })}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

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
import {
  FALLBACK_STYLE,
  styleAttrs,
  themeVars,
  type ProfileTheme,
} from './themes';

/** DTO → 引擎主题（皮肤标识来自 payload.style，其余视觉全在 CSS 里） */
function toTheme(dto: ProfileThemeDTO): ProfileTheme {
  const raw = dto.payload as Record<string, unknown>;
  return {
    slug: dto.slug,
    name: dto.name,
    layout: dto.layout,
    price_credits: dto.price_credits,
    owned: dto.owned,
    applied: dto.applied,
    style: typeof raw.style === 'string' ? (raw.style as string) : FALLBACK_STYLE,
  };
}

/**
 * 缩微样张：用**真实骨架的缩微版**，而不是通用占位图。
 *
 * 关键点：样张自身带上 data-style 皮肤属性，与主页走同一套 SCSS 分支——
 * 所以商店里看到的海报巨卡 + 卡片流的描边语言，就是切过去之后的真实结果。
 * 这正是"两套主题长得不一样"能被验收的前提。
 */
const ThemePreview: React.FC<{ theme: ProfileTheme }> = ({ theme }) => {
  return (
    <div
      className="community-profile2 community-shop__preview"
      data-profile-root
      {...styleAttrs(theme.style)}
      style={themeVars()}
    >
      <div className="community-profile2__poster">
        <div className="community-profile2__poster-glow">
          <span className="community-profile2__poster-wash" />
          <span className="community-profile2__poster-veil" />
        </div>
        <div className="community-profile2__poster-body">
          <div className="community-profile2__poster-idrow">
            <span className="community-profile2__avatar-tile">
              <span className="community-profile2__avatar" />
            </span>
            <div className="community-profile2__poster-name">
              <span className="community-profile2__name">{theme.name}</span>
            </div>
          </div>
          <div className="community-profile2__stats">
            <span className="community-profile2__stat">
              <em className="ds-data">24</em>
            </span>
            <span className="community-profile2__stat">
              <em className="ds-data">1.8k</em>
            </span>
          </div>
        </div>
      </div>
      <div className="community-profile2__works">
        <div className="community-stream__grid">
          {['夜', '雾', '雪', '海'].map((letter) => (
            <div key={letter} className="community-stream-card">
              <div className="community-stream-card__cover">
                <span className="community-stream-card__letter">{letter}</span>
                <span className="community-stream-card__tile" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

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

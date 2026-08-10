import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_AI00_S_BASE_URL } from '@/infrastructure/config/constants';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import {
  mapPlanTierToDisplay,
  TIER_DISPLAY,
  TIER_COLORS,
} from '../services/ai00sTier';
import DeviceBindingSection from './DeviceBindingSection';
import ChatHistoryBackupSection from './ChatHistoryBackupSection';
import { ProfileEditSection } from './ProfileEditSection';
import { setBaseUrlResolver } from '@/infrastructure/account/avatarConfigAdapter';
import { getMemberProfile } from '@/infrastructure/account/api';

interface UsageWindow {
  used: number;
  limit: number;
}

interface AiMeData {
  username: string;
  email: string;
  plan_tier: string;
  tier_display_name: string;
  quota: {
    total_tokens: number;
    used_tokens: number;
    unlimited: boolean;
  };
  rate_limits: {
    window_5h: UsageWindow;
    weekly: UsageWindow;
    monthly: UsageWindow;
  };
  // 扩展资料字段（profile_update 写入，me 返回）
  nickname?: string | null;
  bio?: string | null;
  phone?: string | null;
  location?: string | null;
  website?: string | null;
  birthdate?: string | null;
  gender?: string | null;
  preferred_language?: string | null;
  avatar_data?: string | null;
}

const AccountConfig: React.FC = () => {
  const { t } = useTranslation('settings/account');
  const [authInfo, setAuthInfo] = useState<{ username?: string; plan_tier?: string } | null>(null);
  const [meData, setMeData] = useState<AiMeData | null>(null);
  const [loading, setLoading] = useState(false);

  const tier = authInfo?.plan_tier ? mapPlanTierToDisplay(authInfo.plan_tier) : null;
  const tierColors = tier ? TIER_COLORS[tier] : null;

  const loadInfo = async () => {
    // Step 1: 从 Tauri 拿本地缓存的 username/plan_tier(快速回显)
    let authUsername: string | undefined;
    try {
      const info = await invoke<{ username?: string; plan_tier?: string } | null>('get_auth_info');
      authUsername = info?.username;
      setAuthInfo(info);
    } catch {
      // ignore
    }

    // Step 2: 注入 baseUrl resolver 给 ResourceManager(单例,内部会缓存)
    try {
      const { configManager } = await import('@/infrastructure/config/services/ConfigManager');
      const url = (await configManager.getConfig<string>('app.ai00_s_base_url')) || DEFAULT_AI00_S_BASE_URL;
      setBaseUrlResolver(async () => url);

      // Step 3: 使用 getMemberProfile 走标准 API
      // token 和 baseUrl 由 fetchWithAuth 内部处理(401 自动 refresh + 重试)
      const profile = await getMemberProfile();
      const m = profile.member || ({} as Record<string, unknown>);
      const data: AiMeData = {
        username: (m.username as string) || authUsername || '',
        email: (m.email as string) || '',
        plan_tier: (m.plan_tier as string) || '',
        tier_display_name: (m.plan_tier as string) || '',
        quota: profile.quota || { total_tokens: 0, used_tokens: 0, unlimited: true },
        rate_limits:
          ((m as Record<string, unknown>).rate_limits as AiMeData['rate_limits']) || {
            window_5h: { used: 0, limit: 0 },
            weekly: { used: 0, limit: 0 },
            monthly: { used: 0, limit: 0 },
          },
        // 扩展 profile 字段(若 me 返回则填充,否则保持 null)
        nickname: (m.nickname as string | null) ?? null,
        bio: (m.bio as string | null) ?? null,
        phone: (m.phone as string | null) ?? null,
        location: (m.location as string | null) ?? null,
        website: (m.website as string | null) ?? null,
        birthdate: (m.birthdate as string | null) ?? null,
        gender: (m.gender as string | null) ?? null,
        preferred_language: (m.preferred_language as string | null) ?? null,
        avatar_data: (m.avatar_data as string | null) ?? null,
      };
      setMeData(data);
      if (data.plan_tier) {
        setAuthInfo(prev => ({ ...prev, plan_tier: data.plan_tier, username: data.username || prev?.username }));
      }
    } catch {
      // ignore (未登录或 token 失效)
    }
  };

  useEffect(() => {
    loadInfo();
  }, []);

  const handleRefresh = async () => {
    setLoading(true);
    await loadInfo();
    setLoading(false);
  };

  const handleLogout = async () => {
    try {
      await invoke('clear_auth_info');
    } catch (e) {
      console.error('Failed to logout:', e);
    }
  };

  const renderUsageBar = (used: number, limit: number) => {
    if (limit <= 0) return <span className="ai00-x-account-config__unlimited">{t('usage.unlimited')}</span>;
    const pct = Math.min((used / limit) * 100, 100);
    const isHigh = pct > 80;
    return (
      <div className="ai00-x-account-config__usage">
        <div className="ai00-x-account-config__usage-bar">
          <div
            className={`ai00-x-account-config__usage-fill ${isHigh ? 'ai00-x-account-config__usage-fill--high' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="ai00-x-account-config__usage-text">
          {used} / {limit}
        </span>
      </div>
    );
  };

  const displayTier = meData?.tier_display_name || (tier ? TIER_DISPLAY[tier] : 'Ai00-Free');

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('title', { defaultValue: 'Account' })}
        subtitle={t('subtitle', { defaultValue: 'Manage your account settings' })}
      />
      <ConfigPageContent>
        <ConfigPageSection title={t('userInfo.title', { defaultValue: 'User Information' })}>
          <ConfigPageRow
            label={t('username', { defaultValue: 'Username' })}
            align="center"
          >
            <span className="ai00-x-account-config__value">
              {meData?.username || authInfo?.username || 'Ai00-X User'}
            </span>
          </ConfigPageRow>
          {meData?.email && (
            <ConfigPageRow
              label={t('email', { defaultValue: 'Email' })}
              align="center"
            >
              <span className="ai00-x-account-config__value">{meData.email}</span>
            </ConfigPageRow>
          )}
          <ConfigPageRow
            label={t('plan', { defaultValue: 'Plan' })}
            align="center"
          >
            <span
              className="ai00-x-account-config__tier-badge"
              style={tierColors ? { backgroundColor: tierColors.bg, color: tierColors.text } : undefined}
            >
              {displayTier}
            </span>
          </ConfigPageRow>
        </ConfigPageSection>

        {meData && (
          <ConfigPageSection title={t('profileEdit.title', { defaultValue: 'Edit Profile' })}>
            <ProfileEditSection
              initialProfile={{
                nickname: meData.nickname,
                bio: meData.bio,
                phone: meData.phone,
                location: meData.location,
                website: meData.website,
                birthdate: meData.birthdate,
                gender: meData.gender,
                preferred_language: meData.preferred_language,
                avatar_data: meData.avatar_data,
              }}
              onUpdated={loadInfo}
            />
          </ConfigPageSection>
        )}

        {meData?.rate_limits && (
          <ConfigPageSection
            title={t('usage.title', { defaultValue: 'Ai00-S Usage' })}
            titleSuffix={
              <button
                type="button"
                className="ai00-x-account-config__refresh-btn"
                onClick={handleRefresh}
                disabled={loading}
              >
                <RefreshCw size={14} className={loading ? 'ai00-x-account-config__spin' : ''} />
              </button>
            }
          >
            <ConfigPageRow
              label={t('usage.5h', { defaultValue: '5-Hour Window' })}
              align="center"
            >
              {renderUsageBar(meData.rate_limits.window_5h.used, meData.rate_limits.window_5h.limit)}
            </ConfigPageRow>
            <ConfigPageRow
              label={t('usage.weekly', { defaultValue: 'Weekly' })}
              align="center"
            >
              {renderUsageBar(meData.rate_limits.weekly.used, meData.rate_limits.weekly.limit)}
            </ConfigPageRow>
            <ConfigPageRow
              label={t('usage.monthly', { defaultValue: 'Monthly' })}
              align="center"
            >
              {renderUsageBar(meData.rate_limits.monthly.used, meData.rate_limits.monthly.limit)}
            </ConfigPageRow>
          </ConfigPageSection>
        )}

        <ConfigPageSection title={t('device.deviceManage', { defaultValue: 'Device Management' })}>
          <DeviceBindingSection />
        </ConfigPageSection>

        <ConfigPageSection title={t('chatHistory.title', { defaultValue: 'Chat History' })}>
          <ChatHistoryBackupSection />
        </ConfigPageSection>

        <ConfigPageSection title={t('actions.title', { defaultValue: 'Actions' })}>
          <ConfigPageRow
            label={t('logout', { defaultValue: 'Sign Out' })}
            description={t('logoutDesc', { defaultValue: 'Clear authentication and sign out' })}
            align="center"
          >
            <button
              type="button"
              className="ai00-x-account-config__logout-btn"
              onClick={handleLogout}
            >
              <LogOut size={16} />
              <span>{t('logoutBtn', { defaultValue: 'Sign Out' })}</span>
            </button>
          </ConfigPageRow>
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default AccountConfig;

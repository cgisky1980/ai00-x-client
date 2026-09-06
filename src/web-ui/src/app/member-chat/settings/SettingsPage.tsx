/**
 * SettingsPage — 个人设置页（rail settings 态整页替换聊天区）
 *
 * 左分类导航（账号资料/安全/外观/通知与隐私/关于）+ 右内容区。
 * - 资料 头像（本地上传→canvas 压方 256px→data URL ≤200KB）/昵称/签名，只读账号信息
 * - 安全 修改密码（成功后吊销 token 强制重登）/退出登录
 * - 外观 主题三选：跟随系统 / 宣纸（亮）/ 墨（暗）
 * - 通知与隐私 桌面通知开关（非当前会话新消息触发）+ 隐私说明
 * - 关于 版本与服务器地址（只读）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  Avatar,
  Button,
  confirmDialog,
  Input,
  Switch,
  Tag,
  toastError,
  toastSuccess,
} from '@/component-library';
import {
  Bell,
  Camera,
  Info,
  LogOut,
  Palette,
  ShieldCheck,
  Trash2,
  User,
} from 'lucide-react';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  SYSTEM_THEME_ID,
  useTheme,
  type ThemeId,
} from '@/infrastructure/theme';
import { formatVersion, getVersionInfo } from '@/shared/utils/version';
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import { changeMemberPassword, memberLogout } from '../chatApi';
import { NOTIFY_DESKTOP_KEY, useMemberChatStore } from '../store/memberChatStore';

type SettingsSection = 'profile' | 'security' | 'appearance' | 'notifications' | 'about';

/** 头像 data URL 字符数上限（与后端 avatar_data 校验一致，≈200KB 二进制） */
const AVATAR_MAX_CHARS = 280_000;
const AVATAR_SIZE_PX = 256;

/** 选图 → 居中裁方 → canvas 压缩为 JPEG data URL（超限逐级降质量） */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE_PX;
  canvas.height = AVATAR_SIZE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE_PX,
    AVATAR_SIZE_PX,
  );
  let quality = 0.9;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length > AVATAR_MAX_CHARS && quality > 0.3) {
    quality -= 0.15;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (dataUrl.length > AVATAR_MAX_CHARS) {
    throw new Error('image too large after compression');
  }
  return dataUrl;
}

/* ===== 账号资料 ===== */
const ProfileSection: React.FC = () => {
  const { t } = useI18n();
  const myProfile = useMemberChatStore((s) => s.myProfile);
  const saveMyProfile = useMemberChatStore((s) => s.saveMyProfile);

  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 服务端资料到达后水合一次（之后本地自由编辑）
  useEffect(() => {
    if (!hydrated && myProfile) {
      setNickname(myProfile.nickname || '');
      setBio(myProfile.bio || '');
      setAvatar(myProfile.avatarData);
      setHydrated(true);
    }
  }, [myProfile, hydrated]);

  const dirty = useMemo(() => {
    if (!myProfile) return false;
    return (
      nickname !== (myProfile.nickname || '') ||
      bio !== (myProfile.bio || '') ||
      avatar !== myProfile.avatarData
    );
  }, [myProfile, nickname, bio, avatar]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setAvatar(await fileToAvatarDataUrl(file));
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    const ok = await saveMyProfile({
      nickname: nickname.trim() || null,
      bio: bio.trim() || null,
      avatarData: avatar,
    });
    setSaving(false);
    if (ok) toastSuccess(t('memberChat.profileSaved', { defaultValue: '资料已保存' }));
  };

  const removeAvatar = () => {
    setAvatar(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="member-chat__settings-content">
      <h2 className="member-chat__settings-title">
        {t('memberChat.settingsProfile', { defaultValue: '账号资料' })}
      </h2>

      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.avatar', { defaultValue: '头像' })}
        </span>
        <div className="member-chat__avatar-row">
          <Avatar
            name={myProfile?.username || '?'}
            size="xl"
            src={avatar || undefined}
          />
          <div className="member-chat__avatar-actions">
            <Button variant="secondary" size="small" onClick={() => fileRef.current?.click()}>
              <Camera size={14} aria-hidden />
              {t('memberChat.changeAvatar', { defaultValue: '更换头像' })}
            </Button>
            {avatar && (
              <Button variant="ghost" size="small" onClick={removeAvatar}>
                <Trash2 size={14} aria-hidden />
                {t('memberChat.removeAvatar', { defaultValue: '移除' })}
              </Button>
            )}
          </div>
          {/* 隐藏文件选择：仅图片 */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </div>
        <p className="member-chat__settings-hint">
          {t('memberChat.avatarHint', {
            defaultValue: '支持本地图，自动裁方压缩至 256×256、约 200KB 内。',
          })}
        </p>
      </div>

      <div className="member-chat__settings-group">
        <label className="member-chat__settings-label" htmlFor="settings-nickname">
          {t('memberChat.nickname', { defaultValue: '昵称' })}
        </label>
        <Input
          id="settings-nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={32}
          placeholder={myProfile?.username || ''}
        />
      </div>

      <div className="member-chat__settings-group">
        <label className="member-chat__settings-label" htmlFor="settings-bio">
          {t('memberChat.bio', { defaultValue: '个性签名' })}
        </label>
        <textarea
          id="settings-bio"
          className="member-chat__settings-textarea"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={200}
          rows={3}
          placeholder={t('memberChat.bioPlaceholder', { defaultValue: '介绍一下自己…' })}
        />
      </div>

      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.accountInfo', { defaultValue: '账号信息' })}
        </span>
        <dl className="member-chat__kv-list">
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.username', { defaultValue: '用户名' })}</dt>
            <dd>{myProfile?.username || '—'}</dd>
          </div>
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.memberId', { defaultValue: '会员 ID' })}</dt>
            <dd className="ds-data">{myProfile?.memberId ?? '—'}</dd>
          </div>
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.planTier', { defaultValue: '套餐' })}</dt>
            <dd>
              <Tag color="blue">{myProfile?.planTier || 'free'}</Tag>
            </dd>
          </div>
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.email', { defaultValue: '邮箱' })}</dt>
            <dd>{myProfile?.email || '—'}</dd>
          </div>
        </dl>
      </div>

      <div className="member-chat__settings-actions">
        <Button variant="primary" size="small" disabled={!dirty || saving} onClick={() => void save()}>
          {saving
            ? t('memberChat.saving', { defaultValue: '保存中…' })
            : t('memberChat.save', { defaultValue: '保存' })}
        </Button>
      </div>
    </div>
  );
};

/* ===== 安全 ===== */
const SecuritySection: React.FC = () => {
  const { t } = useI18n();
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = oldPwd && newPwd.length >= 8 && newPwd === confirmPwd && !busy;

  const changePassword = async () => {
    setBusy(true);
    try {
      await changeMemberPassword(oldPwd, newPwd);
      toastSuccess(
        t('memberChat.passwordChanged', { defaultValue: '密码已修改，请重新登录' }),
      );
      // 服务端已吊销 token；清本机会话并刷新 → 回到未登录引导态
      await memberLogout();
      await useMemberChatStore.getState().initSession();
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    const ok = await confirmDialog({
      title: t('memberChat.logoutTitle', { defaultValue: '退出登录' }),
      message: t('memberChat.logoutConfirm', {
        defaultValue: '将登出当前会员账号（本机聊天记录保留）。确认？',
      }),
      confirmDanger: true,
    });
    if (!ok) return;
    try {
      await memberLogout();
      await useMemberChatStore.getState().initSession();
    } catch (e) {
      toastError((e as Error).message);
    }
  };

  return (
    <div className="member-chat__settings-content">
      <h2 className="member-chat__settings-title">
        {t('memberChat.settingsSecurity', { defaultValue: '安全' })}
      </h2>

      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.changePassword', { defaultValue: '修改密码' })}
        </span>
        <div className="member-chat__settings-stack">
          <Input
            type="password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            placeholder={t('memberChat.oldPassword', { defaultValue: '当前密码' })}
            autoComplete="current-password"
          />
          <Input
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            placeholder={t('memberChat.newPassword', {
              defaultValue: '新密码（至少 8 位，含字母和数字）',
            })}
            autoComplete="new-password"
          />
          <Input
            type="password"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
            placeholder={t('memberChat.confirmPassword', { defaultValue: '确认新密码' })}
            autoComplete="new-password"
          />
          {confirmPwd && newPwd !== confirmPwd && (
            <p className="member-chat__settings-error">
              {t('memberChat.passwordMismatch', { defaultValue: '两次输入的新密码不一致' })}
            </p>
          )}
          <div>
            <Button
              variant="primary"
              size="small"
              disabled={!canSubmit}
              onClick={() => void changePassword()}
            >
              {t('memberChat.changePasswordAction', { defaultValue: '修改密码' })}
            </Button>
          </div>
          <p className="member-chat__settings-hint">
            {t('memberChat.passwordChangedHint', {
              defaultValue: '修改成功后会登出当前会话，需用新密码重新登录。',
            })}
          </p>
        </div>
      </div>

      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.session', { defaultValue: '会话' })}
        </span>
        <div>
          <Button variant="danger" size="small" onClick={() => void logout()}>
            <LogOut size={14} aria-hidden />
            {t('memberChat.logout', { defaultValue: '退出登录' })}
          </Button>
        </div>
      </div>
    </div>
  );
};

/* ===== 外观 ===== */
const AppearanceSection: React.FC = () => {
  const { t } = useI18n();
  const { themeId, setTheme } = useTheme();

  const options: { id: string; label: string; description: string }[] = [
    {
      id: SYSTEM_THEME_ID,
      label: t('memberChat.themeSystem', { defaultValue: '跟随系统' }),
      description: t('memberChat.themeSystemDesc', { defaultValue: '与系统明暗保持一致' }),
    },
    {
      id: DEFAULT_LIGHT_THEME_ID,
      label: t('memberChat.themeLight', { defaultValue: '宣纸（亮色）' }),
      description: t('memberChat.themeLightDesc', { defaultValue: '暖宣纸底，日间阅读' }),
    },
    {
      id: DEFAULT_DARK_THEME_ID,
      label: t('memberChat.themeDark', { defaultValue: '墨（暗色）' }),
      description: t('memberChat.themeDarkDesc', { defaultValue: '松烟墨底，夜间使用' }),
    },
  ];

  return (
    <div className="member-chat__settings-content">
      <h2 className="member-chat__settings-title">
        {t('memberChat.settingsAppearance', { defaultValue: '外观' })}
      </h2>
      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.theme', { defaultValue: '主题' })}
        </span>
        <div
          className="member-chat__theme-options"
          role="radiogroup"
          aria-label={t('memberChat.theme', { defaultValue: '主题' })}
        >
          {options.map((o) => {
            const selected = themeId === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`member-chat__theme-option ${selected ? 'is-active' : ''}`}
                onClick={() => setTheme(o.id as ThemeId)}
              >
                <span className="member-chat__theme-name">{o.label}</span>
                <span className="member-chat__theme-desc">{o.description}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/* ===== 通知与隐私 ===== */
const NotificationsSection: React.FC = () => {
  const { t } = useI18n();
  const [notify, setNotify] = useState(
    () => localStorage.getItem(NOTIFY_DESKTOP_KEY) === '1',
  );

  const toggle = (on: boolean) => {
    setNotify(on);
    localStorage.setItem(NOTIFY_DESKTOP_KEY, on ? '1' : '0');
  };

  return (
    <div className="member-chat__settings-content">
      <h2 className="member-chat__settings-title">
        {t('memberChat.settingsNotifications', { defaultValue: '通知与隐私' })}
      </h2>

      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.notifyGroup', { defaultValue: '通知' })}
        </span>
        <Switch
          label={t('memberChat.notifyDesktop', { defaultValue: '桌面通知' })}
          description={t('memberChat.notifyDesktopDesc', {
            defaultValue: '收到非当前会话的新消息时弹出系统通知。',
          })}
          checked={notify}
          onChange={(e) => toggle(e.target.checked)}
        />
      </div>

      <div className="member-chat__settings-group">
        <span className="member-chat__settings-label">
          {t('memberChat.privacyGroup', { defaultValue: '隐私' })}
        </span>
        <p className="member-chat__settings-hint">
          {t('memberChat.privacyHint', {
            defaultValue:
              '私聊消息仅保存在本机（服务器不落库、不暂存），不参与任何云端同步；官方频道消息存储在服务器，仅频道成员可见。',
          })}
        </p>
      </div>
    </div>
  );
};

/* ===== 关于 ===== */
const AboutSection: React.FC<{ serverUrl: string }> = ({ serverUrl }) => {
  const { t } = useI18n();
  const version = getVersionInfo();

  return (
    <div className="member-chat__settings-content">
      <h2 className="member-chat__settings-title">
        {t('memberChat.settingsAbout', { defaultValue: '关于' })}
      </h2>
      <div className="member-chat__settings-group">
        <dl className="member-chat__kv-list">
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.appName', { defaultValue: '应用' })}</dt>
            <dd>{version.name}</dd>
          </div>
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.appVersion', { defaultValue: '版本' })}</dt>
            <dd className="ds-data">{formatVersion(version.version, version.isDev)}</dd>
          </div>
          <div className="member-chat__kv-row">
            <dt>{t('memberChat.server', { defaultValue: '服务器' })}</dt>
            <dd className="ds-data">{serverUrl}</dd>
          </div>
        </dl>
        <p className="member-chat__settings-hint">
          {t('memberChat.serverHint', {
            defaultValue: '服务器地址在主窗口「设置 → 服务器」中切换。',
          })}
        </p>
      </div>
    </div>
  );
};

/* ===== 页面壳：左分类导航 + 右内容 ===== */
export const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const myProfile = useMemberChatStore((s) => s.myProfile);
  const [section, setSection] = useState<SettingsSection>('profile');
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    let alive = true;
    tokenManager
      .getBaseUrl()
      .then((u) => {
        if (alive) setServerUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const sections: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
    {
      key: 'profile',
      label: t('memberChat.settingsProfile', { defaultValue: '账号资料' }),
      icon: <User size={16} strokeWidth={1.8} aria-hidden />,
    },
    {
      key: 'security',
      label: t('memberChat.settingsSecurity', { defaultValue: '安全' }),
      icon: <ShieldCheck size={16} strokeWidth={1.8} aria-hidden />,
    },
    {
      key: 'appearance',
      label: t('memberChat.settingsAppearance', { defaultValue: '外观' }),
      icon: <Palette size={16} strokeWidth={1.8} aria-hidden />,
    },
    {
      key: 'notifications',
      label: t('memberChat.settingsNotifications', { defaultValue: '通知与隐私' }),
      icon: <Bell size={16} strokeWidth={1.8} aria-hidden />,
    },
    {
      key: 'about',
      label: t('memberChat.settingsAbout', { defaultValue: '关于' }),
      icon: <Info size={16} strokeWidth={1.8} aria-hidden />,
    },
  ];

  return (
    <div className="member-chat__settings" data-profile-hydrated={myProfile ? 'yes' : 'no'}>
      <nav className="member-chat__settings-nav" aria-label={t('memberChat.settingsNav', { defaultValue: '设置分类' })}>
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`member-chat__settings-nav-item ${section === s.key ? 'is-active' : ''}`}
            onClick={() => setSection(s.key)}
            aria-current={section === s.key ? 'page' : undefined}
          >
            {s.icon}
            <span>{s.label}</span>
          </button>
        ))}
      </nav>
      <div className="member-chat__settings-main">
        {section === 'profile' && <ProfileSection />}
        {section === 'security' && <SecuritySection />}
        {section === 'appearance' && <AppearanceSection />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'about' && <AboutSection serverUrl={serverUrl} />}
      </div>
    </div>
  );
};

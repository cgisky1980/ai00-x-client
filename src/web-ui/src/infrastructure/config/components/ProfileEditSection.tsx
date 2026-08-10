/**
 * 资料编辑区段（嵌入 AccountConfig 页面）
 *
 * 字段：
 * - avatar_data（AvatarCustomizer 头像编辑器）
 * - nickname / bio / phone / location / website / birthdate / gender / preferred_language
 *
 * 保存：调用 updateMemberProfile API（部分更新）
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfigInput,
  ConfigTextarea,
  ConfigSelect,
  ConfigActions,
  ConfigActionButtons,
  ConfigStatus,
  type ConfigSelectOption,
} from './form-controls';
import { ConfigPageRow } from './common';
import { AvatarCustomizer, type AvatarValue } from '@/infrastructure/account/AvatarCustomizer';
import { saveAvatarLocal } from '@/infrastructure/account/avatarStorage';
import { updateMemberProfile, type ProfileUpdateFields } from '@/infrastructure/account/api';

export interface ProfileEditSectionProps {
  initialProfile: {
    nickname?: string | null;
    bio?: string | null;
    phone?: string | null;
    location?: string | null;
    website?: string | null;
    birthdate?: string | null;
    gender?: string | null;
    preferred_language?: string | null;
    avatar_data?: string | null;
  };
  onUpdated?: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export const ProfileEditSection: React.FC<ProfileEditSectionProps> = ({
  initialProfile,
  onUpdated,
}) => {
  const { t } = useTranslation('settings/account');

  const [nickname, setNickname] = useState(initialProfile.nickname || '');
  const [bio, setBio] = useState(initialProfile.bio || '');
  const [phone, setPhone] = useState(initialProfile.phone || '');
  const [location, setLocation] = useState(initialProfile.location || '');
  const [website, setWebsite] = useState(initialProfile.website || '');
  const [birthdate, setBirthdate] = useState(initialProfile.birthdate || '');
  const [gender, setGender] = useState(initialProfile.gender || '');
  const [preferredLanguage, setPreferredLanguage] = useState(initialProfile.preferred_language || '');

  // 解析 avatar_data (JSON string) 为 AvatarSelection
  const [avatarValue, setAvatarValue] = useState<AvatarValue | null>(() => {
    if (initialProfile.avatar_data) {
      try {
        const parsed = JSON.parse(initialProfile.avatar_data);
        if (parsed && typeof parsed === 'object' && parsed.parts && parsed.colors) {
          return parsed as AvatarValue;
        }
      } catch {
        // ignore parse error
      }
    }
    return null;
  });

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [urlError, setUrlError] = useState('');

  // URL 格式校验:空值合法,非空必须以 http:// 或 https:// 开头
  const validateUrl = (url: string): boolean => {
    if (!url) return true;
    return /^https?:\/\/.+/i.test(url);
  };

  // 检查是否有变更（用于启用 Save 按钮）。URL 格式错误时禁用保存。
  const hasChanges = (() => {
    if (urlError) return false;
    if (nickname !== (initialProfile.nickname || '')) return true;
    if (bio !== (initialProfile.bio || '')) return true;
    if (phone !== (initialProfile.phone || '')) return true;
    if (location !== (initialProfile.location || '')) return true;
    if (website !== (initialProfile.website || '')) return true;
    if (birthdate !== (initialProfile.birthdate || '')) return true;
    if (gender !== (initialProfile.gender || '')) return true;
    if (preferredLanguage !== (initialProfile.preferred_language || '')) return true;
    // avatar 变更检测：序列化后比较
    const originalAvatar = initialProfile.avatar_data || '';
    const currentAvatar = avatarValue ? JSON.stringify(avatarValue) : '';
    if (originalAvatar !== currentAvatar) return true;
    return false;
  })();

  const handleSave = async () => {
    setSaveStatus('saving');
    setErrorMsg('');
    try {
      const fields: ProfileUpdateFields = {
        nickname,
        bio,
        phone,
        location,
        website,
        birthdate: birthdate || undefined,
        gender: gender || undefined,
        preferred_language: preferredLanguage || undefined,
        avatar_data: avatarValue ? JSON.stringify(avatarValue) : null,
      };
      await updateMemberProfile(fields);
      // 同时缓存到 localStorage（用于下次启动快速回填）
      if (avatarValue) {
        await saveAvatarLocal(avatarValue);
      }
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
      onUpdated?.();
    } catch (e) {
      setSaveStatus('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReset = () => {
    setNickname(initialProfile.nickname || '');
    setBio(initialProfile.bio || '');
    setPhone(initialProfile.phone || '');
    setLocation(initialProfile.location || '');
    setWebsite(initialProfile.website || '');
    setUrlError('');
    setBirthdate(initialProfile.birthdate || '');
    setGender(initialProfile.gender || '');
    setPreferredLanguage(initialProfile.preferred_language || '');
    // avatar 重置
    if (initialProfile.avatar_data) {
      try {
        const parsed = JSON.parse(initialProfile.avatar_data);
        if (parsed && typeof parsed === 'object' && parsed.parts && parsed.colors) {
          setAvatarValue(parsed as AvatarValue);
          return;
        }
      } catch {
        // ignore
      }
    }
    setAvatarValue(null);
  };

  const genderOptions: ConfigSelectOption[] = [
    { value: '', label: t('profileEdit.genderPreferNotToSay', { defaultValue: 'Prefer not to say' }) },
    { value: 'male', label: t('profileEdit.genderMale', { defaultValue: 'Male' }) },
    { value: 'female', label: t('profileEdit.genderFemale', { defaultValue: 'Female' }) },
    { value: 'other', label: t('profileEdit.genderOther', { defaultValue: 'Other' }) },
  ];

  const languageOptions: ConfigSelectOption[] = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  return (
    <div className="ai00-x-profile-edit-section">
      {/* Avatar 编辑器（Spine 预览 + 换装面板） */}
      <ConfigPageRow label={t('profileEdit.avatar', { defaultValue: 'Avatar' })} align="start">
        <div style={{ display: 'flex', gap: '12px', width: '100%', minHeight: '320px' }}>
          {/* Spine 预览（左） */}
          <div
            style={{
              width: '200px',
              height: '280px',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {avatarValue ? (
              <AvatarCustomizer
                value={avatarValue}
                onChange={setAvatarValue}
                previewOnly
              />
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  gap: '8px',
                  color: 'var(--text-50)',
                  fontSize: '12px',
                }}
              >
                <span>{t('avatar.notSet', { defaultValue: 'No avatar set' })}</span>
                <button
                  type="button"
                  onClick={() => setAvatarValue({ parts: {}, colors: {} })}
                  style={{
                    padding: '6px 12px',
                    fontSize: '12px',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    background: 'var(--secondary)',
                    color: 'var(--text-90)',
                    cursor: 'pointer',
                  }}
                >
                  {t('profileEdit.createAvatar', { defaultValue: 'Create Avatar' })}
                </button>
              </div>
            )}
          </div>
          {/* 换装面板（右） */}
          <div
            style={{
              flex: 1,
              minHeight: '280px',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              overflow: 'hidden',
            }}
          >
            {avatarValue && (
              <AvatarCustomizer
                value={avatarValue}
                onChange={setAvatarValue}
                panelOnly
              />
            )}
          </div>
        </div>
      </ConfigPageRow>

      {/* 文本字段 */}
      <ConfigPageRow label={t('profileEdit.nickname', { defaultValue: 'Nickname' })} align="center">
        <ConfigInput
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder={t('profileEdit.nickname', { defaultValue: 'Nickname' })}
        />
      </ConfigPageRow>

      <ConfigPageRow label={t('profileEdit.bio', { defaultValue: 'Bio' })} align="start">
        <ConfigTextarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder={t('profileEdit.bio', { defaultValue: 'Bio' })}
          minHeight={80}
        />
      </ConfigPageRow>

      <ConfigPageRow label={t('profileEdit.phone', { defaultValue: 'Phone' })} align="center">
        <ConfigInput
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t('profileEdit.phone', { defaultValue: 'Phone' })}
        />
      </ConfigPageRow>

      <ConfigPageRow label={t('profileEdit.location', { defaultValue: 'Location' })} align="center">
        <ConfigInput
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder={t('profileEdit.location', { defaultValue: 'Location' })}
        />
      </ConfigPageRow>

      <ConfigPageRow label={t('profileEdit.website', { defaultValue: 'Website' })} align="center">
        <ConfigInput
          value={website}
          onChange={(e) => {
            const v = e.target.value;
            setWebsite(v);
            setUrlError(
              validateUrl(v)
                ? ''
                : t('profileEdit.invalidUrl', { defaultValue: 'URL must start with http:// or https://' })
            );
          }}
          placeholder="https://"
          error={urlError || undefined}
        />
      </ConfigPageRow>

      <ConfigPageRow label={t('profileEdit.birthdate', { defaultValue: 'Birthdate' })} align="center">
        <ConfigInput
          type="date"
          value={birthdate}
          onChange={(e) => setBirthdate(e.target.value)}
          max={new Date().toISOString().split('T')[0]}
        />
      </ConfigPageRow>

      <ConfigPageRow label={t('profileEdit.gender', { defaultValue: 'Gender' })} align="center">
        <ConfigSelect
          value={gender}
          onChange={(val) => setGender(String(val))}
          options={genderOptions}
        />
      </ConfigPageRow>

      <ConfigPageRow
        label={t('profileEdit.preferredLanguage', { defaultValue: 'Preferred Language' })}
        align="center"
      >
        <ConfigSelect
          value={preferredLanguage}
          onChange={(val) => setPreferredLanguage(String(val))}
          options={languageOptions}
        />
      </ConfigPageRow>

      <ConfigActions align="end">
        <ConfigActionButtons
          showCancel={false}
          showReset
          showSave
          hasChanges={hasChanges}
          isSaving={saveStatus === 'saving'}
          onSave={handleSave}
          onReset={handleReset}
          saveText={t('profileEdit.save', { defaultValue: 'Save' })}
          resetText={t('profileEdit.reset', { defaultValue: 'Reset' })}
        />
        {saveStatus === 'saved' && (
          <ConfigStatus
            type="success"
            message={t('profileEdit.saved', { defaultValue: 'Saved' })}
          />
        )}
        {saveStatus === 'error' && (
          <ConfigStatus
            type="error"
            message={t('profileEdit.saveFailed', { defaultValue: 'Save failed' }) + (errorMsg ? `: ${errorMsg}` : '')}
            multiline
          />
        )}
      </ConfigActions>
    </div>
  );
};

export default ProfileEditSection;

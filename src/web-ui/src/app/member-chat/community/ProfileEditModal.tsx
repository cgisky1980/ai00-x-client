/**
 * ProfileEditModal — 编辑主页（昵称/bio/主页模板）
 *
 * 复用现有 /me/profile 链路（memberChatStore.saveMyProfile）；
 * 头像编辑沿用设置页 avatarData 链路（此处不重复做）。location/website
 * 后端编辑端点暂未开放，v1 仅展示。
 * 主页模板三选（xuanzhi/juan/yinzhang）：radio 卡组（纯 CSS 缩微示意 + 名称 + 一句描述），
 * 与 ProfileView data-profile-theme、服务端白名单同集。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Input, Modal, Textarea, toastError } from '@/component-library';
import { useMemberChatStore } from '../store/memberChatStore';

/** 主页模板选项（与服务端 PROFILE_THEMES 白名单一致） */
const PROFILE_THEME_OPTIONS = [
  { id: 'xuanzhi', nameKey: 'community.themeXuanzhi', descKey: 'community.themeXuanzhiDesc' },
  { id: 'juan', nameKey: 'community.themeJuan', descKey: 'community.themeJuanDesc' },
  { id: 'yinzhang', nameKey: 'community.themeYinzhang', descKey: 'community.themeYinzhangDesc' },
] as const;

export const ProfileEditModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}> = ({ open, onClose, onSaved }) => {
  const { t } = useI18n();
  const myProfile = useMemberChatStore((s) => s.myProfile);
  const loadMyProfile = useMemberChatStore((s) => s.loadMyProfile);
  const saveMyProfile = useMemberChatStore((s) => s.saveMyProfile);

  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [profileTheme, setProfileTheme] = useState('xuanzhi');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadMyProfile();
    setNickname(myProfile?.nickname ?? '');
    setBio(myProfile?.bio ?? '');
    setProfileTheme(myProfile?.profileTheme ?? 'xuanzhi');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    setSaving(true);
    const ok = await saveMyProfile({
      nickname: nickname.trim() || null,
      bio: bio.trim() || null,
      profileTheme,
    });
    setSaving(false);
    if (!ok) {
      toastError(t('community.profileSaveFailed', { defaultValue: '保存失败，请重试' }));
      return;
    }
    onClose();
    onSaved();
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('community.editProfileTitle', { defaultValue: '编辑主页' })}
      size="small"
    >
      <Input
        label={t('community.fieldNickname', { defaultValue: '昵称' })}
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        maxLength={30}
        placeholder={myProfile?.username}
      />
      <Textarea
        label={t('community.fieldBio', { defaultValue: '简介' })}
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        maxLength={200}
        rows={4}
        showCount
        placeholder={t('community.fieldBioPlaceholder', { defaultValue: '介绍一下自己…' })}
      />

      {/* 主页模板三选（radio 卡组） */}
      <div
        className="community-profile-theme"
        role="radiogroup"
        aria-label={t('community.themeLabel', { defaultValue: '主页模板' })}
      >
        <span className="community-profile-theme__label">
          {t('community.themeLabel', { defaultValue: '主页模板' })}
        </span>
        <div className="community-profile-theme__options">
          {PROFILE_THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={profileTheme === opt.id}
              className={`community-profile-theme__card ${profileTheme === opt.id ? 'is-active' : ''}`}
              onClick={() => setProfileTheme(opt.id)}
            >
              <span className={`community-profile-theme__mini community-profile-theme__mini--${opt.id}`} aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <span className="community-profile-theme__name">
                {t(opt.nameKey, {
                  defaultValue:
                    opt.id === 'xuanzhi' ? '宣纸' : opt.id === 'juan' ? '卷轴' : '印章',
                })}
              </span>
              <span className="community-profile-theme__desc">
                {t(opt.descKey, {
                  defaultValue:
                    opt.id === 'xuanzhi'
                      ? '留白为息，窄栏动态墙'
                      : opt.id === 'juan'
                        ? '墨色横幅，头像叠压'
                        : '左墨栏竖排，非对称',
                })}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="community-composer__actions">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel', { defaultValue: '取消' })}
        </Button>
        <Button variant="primary" isLoading={saving} onClick={() => void submit()}>
          {t('common.save', { defaultValue: '保存' })}
        </Button>
      </div>
    </Modal>
  );
};

/**
 * ProfileEditModal — 编辑主页（P2B：昵称/bio/位置/网站/banner 封面 + 主题区）
 *
 * 复用 /me/profile 链路（memberChatStore.saveMyProfile，服务端已支持
 * location/website/cover）。封面走社区媒体上传（相对 URL 落 cover 字段）。
 * 主题区：主题商店入口（P2C）；旧三套模板 radio 已废弃（迁移 027 值迁移 songyan）。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Input, Modal, Textarea, toastError, toastSuccess } from '@/component-library';
import { Palette, Upload } from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { communityApi, resolveMediaUrl } from './communityApi';

export const ProfileEditModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** 打开主题商店（由父级挂载 ThemeShop） */
  onShop?: () => void;
}> = ({ open, onClose, onSaved, onShop }) => {
  const { t } = useI18n();
  const myProfile = useMemberChatStore((s) => s.myProfile);
  const loadMyProfile = useMemberChatStore((s) => s.loadMyProfile);
  const saveMyProfile = useMemberChatStore((s) => s.saveMyProfile);

  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [website, setWebsite] = useState('');
  const [coverPath, setCoverPath] = useState('');
  const [coverPreview, setCoverPreview] = useState('');
  const [coverUploading, setCoverUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadMyProfile();
  }, [open, loadMyProfile]);

  useEffect(() => {
    if (!open || !myProfile) return;
    setNickname(myProfile.nickname ?? '');
    setBio(myProfile.bio ?? '');
    setLocation(myProfile.location ?? '');
    setWebsite(myProfile.website ?? '');
    setCoverPath(myProfile.coverPath ?? '');
    let alive = true;
    void (myProfile.coverPath
      ? resolveMediaUrl(myProfile.coverPath)
      : Promise.resolve('')
    )
      .then((u) => {
        if (alive) setCoverPreview(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, myProfile]);

  const pickCover = async (file: File | undefined) => {
    if (!file) return;
    setCoverUploading(true);
    try {
      const r = await communityApi.uploadMedia(file);
      setCoverPath(r.url);
      setCoverPreview(await resolveMediaUrl(r.thumb_url || r.url));
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverUploading(false);
    }
  };

  const submit = async () => {
    setSaving(true);
    const ok = await saveMyProfile({
      nickname: nickname.trim() || null,
      bio: bio.trim() || null,
      location: location.trim() || null,
      website: website.trim() || null,
      coverPath,
    });
    setSaving(false);
    if (!ok) {
      toastError(t('profileSaveFailed', { defaultValue: '保存失败，请重试' }));
      return;
    }
    toastSuccess(t('profileSaved', { defaultValue: '资料已保存' }));
    onClose();
    onSaved?.();
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('editProfileTitle', { defaultValue: '编辑主页' })}
      size="small"
    >
      <Input
        label={t('fieldNickname', { defaultValue: '昵称' })}
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        maxLength={30}
        placeholder={myProfile?.username}
      />
      <Textarea
        label={t('fieldBio', { defaultValue: '简介' })}
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        maxLength={200}
        rows={3}
        showCount
        placeholder={t('fieldBioPlaceholder', { defaultValue: '介绍一下自己…' })}
      />
      <Input
        label={t('fieldLocation', { defaultValue: '位置' })}
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        maxLength={64}
        placeholder={t('fieldLocationPlaceholder', { defaultValue: '如：杭州' })}
      />
      <Input
        label={t('fieldWebsite', { defaultValue: '网站' })}
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        maxLength={256}
        placeholder="https://"
      />

      {/* banner 封面 */}
      <div className="community-edit-cover">
        <span className="community-edit-cover__label">{t('fieldCover', { defaultValue: '主页封面' })}</span>
        <div className="community-edit-cover__row">
          {coverPreview && <img className="community-edit-cover__img" src={coverPreview} alt="" />}
          <label className="community-edit-cover__pick">
            <Upload size={13} aria-hidden />
            {coverUploading
              ? t('uploading', { defaultValue: '上传中…' })
              : coverPreview
                ? t('replaceCover', { defaultValue: '更换封面' })
                : t('uploadCover', { defaultValue: '上传封面' })}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void pickCover(e.target.files?.[0])}
            />
          </label>
          {coverPath && (
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                setCoverPath('');
                setCoverPreview('');
              }}
            >
              {t('removeCover', { defaultValue: '移除' })}
            </Button>
          )}
        </div>
      </div>

      {/* 主题区 */}
      <div className="community-edit-theme">
        <span className="community-edit-theme__label">
          <Palette size={13} aria-hidden />
          {t('themeLabel', { defaultValue: '主页主题' })}
        </span>
        <Button variant="secondary" size="small" disabled={!onShop} onClick={() => onShop?.()}>
          {t('openThemeShop', { defaultValue: '主题商店' })}
        </Button>
      </div>

      <div className="community-composer__actions">
        <Button variant="ghost" onClick={onClose}>
          {t('cancel', { defaultValue: '取消' })}
        </Button>
        <Button variant="primary" isLoading={saving} onClick={() => void submit()}>
          {t('save', { defaultValue: '保存' })}
        </Button>
      </div>
    </Modal>
  );
};

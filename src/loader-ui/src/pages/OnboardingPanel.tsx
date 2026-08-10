import { useState, useMemo, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { AvatarCustomizer, type AvatarValue } from '@/lib/avatar/AvatarCustomizer';
import { resourceManager } from '@/lib/avatar/ResourceManager';
import { createDefaultSelection, hslToHex, type AvatarConfigFile } from '@/lib/avatar/config/avatar-config';
import { LocationPicker } from '@/components/LocationPicker';
import { type ProfileUpdateFields } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export interface ProgressInfo {
  status: string;
  progress: number;
  initialized: boolean;
  failed: boolean;
}

export interface OnboardingPanelProps {
  initialProfile?: ProfileUpdateFields;
  onComplete: (fields: ProfileUpdateFields) => void;
  saving?: boolean;
  /** 编辑模式：已设置过形象，只显示预览和进度，隐藏资料填写和配件选择 */
  editMode?: boolean;
  /** 进度信息（显示在 Spine 预览上方） */
  progressInfo?: ProgressInfo;
  /** 是否可以进入主应用（editMode + 初始化完成） */
  canEnter?: boolean;
  /** 用户已点击进入，等待打开 */
  entering?: boolean;
  /** 点击进入主应用的回调 */
  onEnter?: () => void;
}

// 生成随机昵称
function generateRandomNickname(prefix: string): string {
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}-${num}`;
}

// 从 avatar_data JSON 解析 AvatarValue
function parseAvatarData(avatarData: string | null | undefined): AvatarValue | null {
  if (!avatarData) return null;
  try {
    const parsed = JSON.parse(avatarData);
    if (parsed && typeof parsed.parts === 'object' && typeof parsed.colors === 'object') {
      return {
        parts: parsed.parts || {},
        colors: parsed.colors || {},
      };
    }
  } catch {
    // ignore parse error
  }
  return null;
}

export function OnboardingPanel({ initialProfile, onComplete, saving, editMode, progressInfo, canEnter, entering, onEnter }: OnboardingPanelProps) {
  const { t } = useI18n();
  const [config, setConfig] = useState<AvatarConfigFile | null>(null);

  // 加载 config.json 获取默认选中
  useEffect(() => {
    let cancelled = false;
    resourceManager
      .init()
      .then(() => fetch(resourceManager.getConfigUrl()))
      .then((resp) => resp.json())
      .then((data: AvatarConfigFile) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => { /* fallback below */ });
    return () => { cancelled = true; };
  }, []);

  // 初始化 avatar 值
  const initialAvatar = useMemo(() => {
    const parsed = parseAvatarData(initialProfile?.avatar_data);
    if (parsed) return parsed;
    return { parts: {}, colors: {} } as AvatarValue;
  }, [initialProfile?.avatar_data]);

  const [avatar, setAvatar] = useState<AvatarValue>(initialAvatar);

  // config 加载后，如果 avatar 是空的，用默认 selection 填充
  useEffect(() => {
    if (config && Object.keys(avatar.parts).length === 0) {
      setAvatar(createDefaultSelection(config));
    }
  }, [config, avatar.parts]);

  // initialProfile.avatar_data 变化时（本地回填或服务端同步到达），更新 avatar
  useEffect(() => {
    const parsed = parseAvatarData(initialProfile?.avatar_data);
    if (parsed) setAvatar(parsed);
  }, [initialProfile?.avatar_data]);

  const [nickname, setNickname] = useState(initialProfile?.nickname || generateRandomNickname(t('defaultNicknamePrefix')));
  const [gender, setGender] = useState(initialProfile?.gender || '');
  const [birthdate, setBirthdate] = useState(initialProfile?.birthdate || '');
  const [location, setLocation] = useState(initialProfile?.location || '');

  // 随机昵称 + 随机 avatar（部件变体 + 颜色），衣服和眼睛保持不变
  const handleRandom = () => {
    setNickname(generateRandomNickname(t('defaultNicknamePrefix')));
    if (config) {
      const parts: Record<string, string> = { ...avatar.parts };
      const colors: Record<string, string> = {};
      for (const part of config.parts) {
        // 衣服和眼睛保持当前值，不随机
        if (part.partId === 'clothes' || part.partId === 'eye') continue;
        if (part.variants.length > 0) {
          const v = part.variants[Math.floor(Math.random() * part.variants.length)];
          parts[part.partId] = v.variantId;
        }
        if (part.isColorable) {
          const hue = Math.floor(Math.random() * 360);
          for (const slot of part.slots) {
            const slotName = slot.split('/').pop() || slot;
            colors[slotName] = hslToHex(hue, 60, 80);
          }
        }
      }
      setAvatar({ parts, colors });
    }
  };

  const handleSave = () => {
    if (!nickname.trim()) return;
    const fields: ProfileUpdateFields = {
      nickname: nickname.trim(),
      avatar_data: JSON.stringify(avatar),
      location: location.trim() || undefined,
      birthdate: birthdate || undefined,
      gender: gender || undefined,
    };
    onComplete(fields);
  };

  const canSave = nickname.trim().length > 0 && gender && !saving;

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--secondary)',
    borderColor: 'var(--border)',
    color: 'var(--text-90)',
  };

  return (
    <div
      className="h-full w-full flex relative overflow-hidden"
      style={{
        background: 'var(--card-bg)',
        color: 'var(--text-90)',
      }}
    >
      {/* 背景光效装饰（主题色） */}
      <div
        className="absolute top-[-100px] left-[-100px] w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(var(--primary), 0.12), transparent 70%)' }}
      />
      <div
        className="absolute bottom-[-100px] right-[200px] w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(var(--primary), 0.08), transparent 70%)' }}
      />

      {/* ===== 左侧区域 ===== */}
      <div className="flex-1 flex flex-col p-6 gap-4 min-w-0 relative z-10">
        {/* 进度信息（显示在 canvas 上方） */}
        {progressInfo && (
          <ProgressInfoBlock info={progressInfo} />
        )}

        {/* 形象预览 */}
        <div
          className={`flex-1 rounded-2xl border flex items-center justify-center relative overflow-hidden ${editMode && canEnter ? 'cursor-pointer group' : ''}`}
          style={{
            borderColor: editMode && canEnter ? 'rgb(var(--primary))' : 'var(--border)',
            background: 'radial-gradient(ellipse at center, rgba(var(--primary), 0.06), var(--card-bg))',
            boxShadow: editMode && canEnter
              ? 'inset 0 0 40px rgba(var(--primary), 0.08), 0 0 20px rgba(var(--primary), 0.15)'
              : 'inset 0 0 40px rgba(var(--primary), 0.05)',
            transition: 'all 0.3s ease',
          }}
          onClick={editMode && canEnter && onEnter ? onEnter : undefined}
        >
          {/* 顶部标题 */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
            <h2
              className="text-lg font-bold tracking-wide"
              style={{ color: 'var(--text-90)', textShadow: '0 0 10px rgba(var(--primary), 0.4)' }}
            >
              {editMode ? (canEnter ? t('welcomeBack') : t('initBooting')) : t('onboardingTitle')}
            </h2>
          </div>

          {/* Spine 预览 - 复用 AvatarCustomizer 的 canvas（响应式填满父容器） */}
          <AvatarCustomizer value={avatar} onChange={setAvatar} previewOnly />

          {/* editMode 下的进入按钮/提示（浮在形象底部） */}
          {editMode && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 pointer-events-none">
              {entering ? (
                <div className="flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-base"
                  style={{ background: 'rgba(var(--primary), 0.2)', color: 'rgb(var(--primary))' }}>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {t('homeOpenMainApp')}
                </div>
              ) : canEnter ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onEnter?.(); }}
                  className="pointer-events-auto px-8 py-3 rounded-full font-bold text-base tracking-wide transition-all duration-300 hover:scale-105 active:scale-95"
                  style={{
                    background: 'linear-gradient(135deg, rgb(var(--primary)), rgba(var(--primary), 0.8))',
                    color: 'white',
                    boxShadow: '0 4px 20px rgba(var(--primary), 0.4), 0 0 40px rgba(var(--primary), 0.15)',
                  }}
                >
                  {t('enterApp')}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium"
                  style={{ background: 'var(--secondary)', color: 'var(--text-50)' }}>
                  <Loader2 className="w-4 h-4 animate-spin" style={{ animationDuration: '1.5s' }} />
                  {t('waitForInit')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 左下：资料填写（仅首次设置时显示，editMode 下隐藏） */}
        {!editMode && (
        <div
          className="rounded-2xl border p-4"
          style={{
            borderColor: 'var(--border)',
            backgroundColor: 'var(--secondary)',
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {/* 昵称（必填 *） */}
            <div>
              <label className="text-xs block mb-1 font-medium" style={{ color: 'var(--text-50)' }}>
                {t('nickname')} <span style={{ color: 'var(--destructive)' }}>*</span>
              </label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder={t('nicknamePlaceholder')}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition-all focus:border-[rgb(var(--primary))]"
                style={inputStyle}
                maxLength={32}
              />
            </div>

            {/* 性别（必填 *） */}
            <div>
              <label className="text-xs block mb-1 font-medium" style={{ color: 'var(--text-50)' }}>
                {t('gender')} <span style={{ color: 'var(--destructive)' }}>*</span>
              </label>
              <div className="flex gap-1">
                {(['male', 'female', 'secret'] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGender(g)}
                    className="flex-1 rounded-lg border py-2 text-xs font-medium transition-all"
                    style={{
                      borderColor: gender === g ? 'rgb(var(--primary))' : 'var(--border)',
                      backgroundColor: gender === g ? 'rgba(var(--primary), 0.18)' : 'var(--secondary)',
                      color: gender === g ? 'rgb(var(--primary))' : 'var(--text-50)',
                      boxShadow: gender === g ? '0 0 8px rgba(var(--primary), 0.3)' : 'none',
                    }}
                  >
                    {t(`gender${g.charAt(0).toUpperCase() + g.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 生日 + 所在地 */}
          <div className="grid grid-cols-2 gap-2 mt-3">
            {/* 生日（年/月/日 选择器，层级可控，限制 1950-今年，禁止未来） */}
            <BirthdatePicker
              value={birthdate}
              onChange={setBirthdate}
              inputStyle={inputStyle}
              placeholder={t('birthdate')}
            />
            {/* 所在地（世界地图选择） */}
            <LocationPicker
              value={location}
              onChange={setLocation}
              inputStyle={inputStyle}
              placeholder={t('locationPlaceholder')}
            />
          </div>

          {/* 按钮区：随机 + 保存 */}
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={handleRandom}
              className="flex-1 rounded-lg border py-2 text-sm font-medium transition-all hover:opacity-80"
              style={{ borderColor: 'var(--border)', color: 'var(--text-50)' }}
              disabled={saving}
            >
              🎲 {t('random')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex-1 rounded-lg py-2 text-sm font-bold transition-all"
              style={{
                background: canSave
                  ? 'rgb(var(--primary))'
                  : 'var(--secondary)',
                color: canSave ? 'white' : 'var(--text-50)',
                boxShadow: canSave ? '0 4px 16px rgba(var(--primary), 0.35)' : 'none',
                cursor: canSave ? 'pointer' : 'not-allowed',
              }}
              disabled={!canSave}
            >
              {saving ? '...' : t('save')}
            </button>
          </div>
        </div>
        )}
      </div>

      {/* ===== 右侧：换装面板（仅首次设置时显示，editMode 下隐藏） ===== */}
      {!editMode && (
      <div
        className="w-[420px] border-l flex flex-col relative z-10"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card-bg)' }}
      >
        {/* 右侧标题 */}
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <h3 className="text-base font-bold tracking-wide" style={{ color: 'var(--text-90)' }}>
            ✦ {t('avatarParts')}
          </h3>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-50)' }}>
            {t('customizeYourLook')}
          </p>
        </div>

        {/* 换装内容（标签页式） */}
        <div className="flex-1 overflow-hidden">
          <AvatarCustomizer
            value={avatar}
            onChange={setAvatar}
            panelOnly
          />
        </div>
      </div>
      )}
    </div>
  );
}

// ===== 进度信息块（显示在 Spine 预览下方） =====
function ProgressInfoBlock({ info }: { info: ProgressInfo }) {
  const { t } = useI18n();
  const { status, progress, initialized, failed } = info;

  // 计算进度条宽度
  const barWidth = failed
    ? '100%'
    : initialized
    ? '100%'
    : progress > 0
    ? `${progress}%`
    : undefined;

  // 进度条是否显示脉冲动画（初始化中且无具体进度时）
  const isPulsing = !initialized && !failed && progress === 0;

  // 状态副文字
  const subStatus = failed
    ? t('initFailed')
    : progress > 0 && progress < 100
    ? `${t('homeProgressDownloading')} ${progress}%`
    : initialized
    ? t('homeProgressReady')
    : t('homeProgressInitializing');

  return (
    <div
      className="rounded-2xl border px-4 py-3 flex flex-col gap-2"
      style={{
        borderColor: 'var(--border)',
        backgroundColor: 'var(--secondary)',
      }}
    >
      {/* 状态行：图标 + 状态文字 */}
      <div className="flex items-center gap-2 min-h-[20px]">
        {failed ? (
          <span className="text-base font-bold" style={{ color: 'var(--destructive)' }}>!</span>
        ) : initialized ? (
          <span className="text-base font-bold" style={{ color: 'rgb(var(--primary))', textShadow: '0 0 8px rgba(var(--primary), 0.5)' }}>✓</span>
        ) : (
          <Loader2
            className="w-4 h-4 animate-spin"
            style={{ color: 'rgb(var(--primary))', animationDuration: '1.5s' }}
          />
        )}
        <span
          className="text-sm font-medium tracking-wide truncate"
          style={{ color: 'var(--text-90)' }}
        >
          {status}
        </span>
      </div>

      {/* 进度条 */}
      <div
        className="w-full h-1.5 rounded-full overflow-hidden border relative"
        style={{ backgroundColor: 'var(--card-bg)', borderColor: 'var(--border)' }}
      >
        <div
          className={`absolute top-0 left-0 h-full rounded-full transition-all duration-300 ease-out ${
            isPulsing ? 'w-full animate-[pulse_2s_ease-in-out_infinite] opacity-50' : ''
          }`}
          style={{
            width: barWidth,
            backgroundColor: failed ? 'var(--destructive)' : 'rgb(var(--primary))',
            boxShadow: failed ? 'none' : '0 0 10px rgba(var(--primary), 0.5)',
          }}
        />
      </div>

      {/* 副状态文字 */}
      <div
        className="text-xs font-mono tracking-widest"
        style={{ color: 'var(--text-50)' }}
      >
        {subStatus}
      </div>
    </div>
  );
}

// ===== 生日选择器（年/月/日 三个 select，层级可控，1950-今年，禁止未来） =====
function BirthdatePicker({
  value,
  onChange,
  inputStyle,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  inputStyle: React.CSSProperties;
  placeholder: string;
}) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const currentDay = today.getDate();

  // 内部状态：单独维护年/月/日，三者齐全才通知父级
  const [year, setYear] = useState(0);
  const [month, setMonth] = useState(0);
  const [day, setDay] = useState(0);

  // 从外部 value 初始化（仅当 value 变化时）
  useEffect(() => {
    if (value) {
      const [y, m, d] = value.split('-').map(Number);
      setYear(y || 0);
      setMonth(m || 0);
      setDay(d || 0);
    } else {
      setYear(0); setMonth(0); setDay(0);
    }
  }, [value]);

  const years: number[] = [];
  for (let yr = currentYear; yr >= 1950; yr--) years.push(yr);

  const maxMonth = year === currentYear ? currentMonth : 12;
  const months: number[] = [];
  for (let mo = 1; mo <= maxMonth; mo++) months.push(mo);

  const days: number[] = [];
  if (year && month) {
    const maxDay = new Date(year, month, 0).getDate();
    const limit = year === currentYear && month === currentMonth ? Math.min(maxDay, currentDay) : maxDay;
    for (let dy = 1; dy <= limit; dy++) days.push(dy);
  }

  const notify = (y: number, m: number, d: number) => {
    if (y && m && d) {
      onChange(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    } else if (!y && !m && !d) {
      onChange('');
    }
    // 部分选择时不通知父级，保留内部状态
  };

  const onYearChange = (y: number) => {
    setYear(y);
    setMonth(0);
    setDay(0);
    notify(y, 0, 0);
  };

  const onMonthChange = (m: number) => {
    setMonth(m);
    setDay(0);
    notify(year, m, 0);
  };

  const onDayChange = (d: number) => {
    setDay(d);
    notify(year, month, d);
  };

  const selectClass = 'rounded-lg border px-2 py-1.5 text-xs outline-none focus:border-[rgb(var(--primary))]';

  return (
    <div className="flex gap-1">
      <select
        value={year}
        onChange={(e) => onYearChange(Number(e.target.value))}
        className={`flex-1 ${selectClass}`}
        style={inputStyle}
      >
        <option value={0}>{placeholder}</option>
        {years.map((yr) => (
          <option key={yr} value={yr}>{yr}</option>
        ))}
      </select>
      <select
        value={month}
        onChange={(e) => onMonthChange(Number(e.target.value))}
        className={`${selectClass}`}
        style={inputStyle}
        disabled={!year}
      >
        <option value={0}>--</option>
        {months.map((mo) => (
          <option key={mo} value={mo}>{String(mo).padStart(2, '0')}</option>
        ))}
      </select>
      <select
        value={day}
        onChange={(e) => onDayChange(Number(e.target.value))}
        className={`${selectClass}`}
        style={inputStyle}
        disabled={!year || !month}
      >
        <option value={0}>--</option>
        {days.map((dy) => (
          <option key={dy} value={dy}>{String(dy).padStart(2, '0')}</option>
        ))}
      </select>
    </div>
  );
}

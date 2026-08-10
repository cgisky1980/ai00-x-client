import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import {
  type AvatarConfigFile,
  type AvatarSelection,
  hslToHex,
} from '../avatar-config';
import type { AvatarResourceManager } from '../avatar-resource';

// lazy load SpineAvatarCanvas 避免 spine-canvas 影响首屏
const SpineAvatarCanvas = lazy(() => import('./SpineAvatarCanvas'));

export type AvatarValue = AvatarSelection;

export interface AvatarCustomizerProps {
  value: AvatarValue;
  onChange: (value: AvatarValue) => void;
  /** i18n 翻译函数（由各包注入，统一使用 avatar.* 嵌套 key） */
  t: (key: string) => string;
  /** 资源管理器（由各包注入，负责 baseUrl 与存储） */
  resourceManager: AvatarResourceManager;
  /** 只显示 Spine 预览，隐藏换装面板 */
  previewOnly?: boolean;
  /** 只显示换装面板，隐藏 Spine 预览 */
  panelOnly?: boolean;
}

// 部件 emoji 图标映射
const PART_EMOJI: Record<string, string> = {
  head: '👤',
  body: '🧍',
  clothes: '👔',
  hands: '🧤',
  legs: '👖',
  eye: '👀',
  glasses: '🕶️',
  effects: '✨',
  weapons: '⚔️',
};

// 部件多语言 key 映射（统一 avatar.* 嵌套 key）
const PART_I18N_KEY: Record<string, string> = {
  head: 'avatar.partHead',
  body: 'avatar.partBody',
  clothes: 'avatar.partClothes',
  hands: 'avatar.partHands',
  legs: 'avatar.partLegs',
  eye: 'avatar.partEye',
  glasses: 'avatar.partGlasses',
  effects: 'avatar.partEffects',
  weapons: 'avatar.partWeapons',
};

// panelOnly 模式下隐藏的部件（用户不可选择，但保留默认值）
const HIDDEN_PARTS_IN_PANEL = new Set(['effects', 'weapons', 'clothes', 'eye']);

export function AvatarCustomizer({ value, onChange, previewOnly, panelOnly, t, resourceManager }: AvatarCustomizerProps) {
  // panelOnly 模式下不渲染 preview（previewOnly 与 panelOnly 互斥，逻辑上 panelOnly 等同默认模式）
  void panelOnly;
  const [config, setConfig] = useState<AvatarConfigFile | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('');
  const tabScrollRef = useRef<HTMLDivElement>(null);

  // 加载 config.json
  useEffect(() => {
    let cancelled = false;
    resourceManager
      .init()
      .then(() => fetch(resourceManager.getConfigUrl()))
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then((data: AvatarConfigFile) => {
        if (!cancelled) {
          setConfig(data);
          // 默认激活第一个非隐藏部件标签
          const firstVisible = data.parts.find(p => !HIDDEN_PARTS_IN_PANEL.has(p.partId));
          if (firstVisible) {
            setActiveTab(firstVisible.partId);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setConfigError(err instanceof Error ? err.message : t('avatar.loadConfigFailed'));
      });
    return () => { cancelled = true; };
  }, [t, resourceManager]);

  const handlePartChange = (partId: string, variantId: string) => {
    onChange({
      ...value,
      parts: { ...value.parts, [partId]: variantId },
    });
  };

  // 标签页滚轮横向滚动
  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [config]);

  // ===== previewOnly 模式：只显示 Spine 预览 =====
  if (previewOnly) {
    if (configError) {
      return (
        <div className="text-xs" style={{ color: 'var(--destructive)' }}>
          {t('avatar.loading')}: {configError}
        </div>
      );
    }
    if (!config) {
      return (
        <div className="text-xs" style={{ color: 'var(--text-50)' }}>
          {t('avatar.loading')}
        </div>
      );
    }
    return (
      <Suspense
        fallback={
          <div style={{ color: 'var(--text-50)', fontSize: '12px' }}>
            {t('avatar.loading')}
          </div>
        }
      >
        <SpineAvatarCanvas
          selection={value}
          partDefs={config.parts}
          resourceManager={resourceManager}
          className="w-full h-full"
        />
      </Suspense>
    );
  }

  // ===== panelOnly 模式：只显示换装面板（标签页式） =====
  if (configError) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--destructive)' }}>
        {t('avatar.loading')}: {configError}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--text-50)' }}>
        {t('avatar.loading')}
      </div>
    );
  }

  // 过滤掉隐藏部件（effects, weapons）
  const visibleParts = config.parts.filter(p => !HIDDEN_PARTS_IN_PANEL.has(p.partId));

  // 找到当前激活的部件
  const activePart = visibleParts.find(p => p.partId === activeTab) || visibleParts[0];
  const selectedVariant = activePart ? (value.parts[activePart.partId] || 'default') : '';

  return (
    <div className="h-full flex flex-col" style={{ color: 'var(--text-90)' }}>
      {/* ===== 标签栏（横向滚动，emoji 图标 + 多语言 tooltip） ===== */}
      <div
        ref={tabScrollRef}
        className="flex gap-1 px-3 py-2 overflow-x-auto overflow-y-hidden border-b"
        style={{
          borderColor: 'var(--border)',
          scrollbarWidth: 'thin',
        }}
      >
        {visibleParts.map((part) => {
          const isActive = part.partId === activeTab;
          const partVariant = value.parts[part.partId];
          const isSet = partVariant && partVariant !== 'default' && partVariant !== 'none';
          const emoji = PART_EMOJI[part.partId] || '❓';
          const i18nKey = PART_I18N_KEY[part.partId];
          const label = i18nKey ? t(i18nKey) : part.label;
          return (
            <button
              key={part.partId}
              type="button"
              onClick={() => setActiveTab(part.partId)}
              title={label}
              className="flex-shrink-0 flex flex-col items-center justify-center px-4 py-2 rounded-lg text-base transition-all relative min-w-[56px]"
              style={{
                background: isActive
                  ? 'rgba(var(--primary), 0.18)'
                  : 'var(--secondary)',
                border: isActive
                  ? '1px solid rgba(var(--primary), 0.5)'
                  : '1px solid var(--border)',
                boxShadow: isActive ? '0 2px 8px rgba(var(--primary), 0.2)' : 'none',
              }}
            >
              <span style={{ fontSize: '22px', lineHeight: 1 }}>{emoji}</span>
              <span
                className="text-[11px] mt-1"
                style={{
                  color: isActive ? 'var(--text-90)' : 'var(--text-50)',
                }}
              >
                {label}
              </span>
              {isSet && !isActive && (
                <span
                  className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full"
                  style={{ background: 'rgb(var(--primary))' }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ===== 变体网格（当前标签的变体列表） ===== */}
      <div className="flex-1 overflow-y-auto p-3">
        {activePart && (
          <div>
            {/* 颜色选择器（仅 isColorable 部件显示） */}
            {activePart.isColorable && (
              <ColorPicker
                t={t}
                slots={activePart.slots}
                colors={value.colors}
                onChange={(slotNames, colorHex) => {
                  const newColors = { ...value.colors };
                  for (const slotName of slotNames) {
                    if (colorHex) {
                      newColors[slotName] = colorHex;
                    } else {
                      delete newColors[slotName];
                    }
                  }
                  onChange({ ...value, colors: newColors });
                }}
              />
            )}
            {/* 变体网格 */}
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
              }}
            >
              {/* "无" 选项（allowNone） */}
              {activePart.allowNone && (
                <VariantCard
                  label={t('avatar.none')}
                  selected={selectedVariant === 'none'}
                  onClick={() => handlePartChange(activePart.partId, 'none')}
                  isNone
                  resourceManager={resourceManager}
                />
              )}

              {/* 变体列表 */}
              {activePart.variants.map((v) => (
                <VariantCard
                  key={v.variantId}
                  label={v.label}
                  selected={selectedVariant === v.variantId}
                  onClick={() => handlePartChange(activePart.partId, v.variantId)}
                  partId={activePart.partId}
                  variantId={v.variantId}
                  resourcePath={activePart.resourcePath}
                  resourceType={activePart.resourceType}
                  resourceManager={resourceManager}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== 变体卡片组件 =====
interface VariantCardProps {
  label: string;
  selected: boolean;
  onClick: () => void;
  isNone?: boolean;
  partId?: string;
  variantId?: string;
  resourcePath?: string;
  resourceType?: string;
  resourceManager: AvatarResourceManager;
}

function VariantCard({ label, selected, onClick, isNone, variantId, resourcePath, resourceType, resourceManager }: VariantCardProps) {
  // 计算预览图 URL：{resolvedResourcePath}/{variantId}.png
  const previewUrl = (!isNone && resourcePath && variantId && resourceType === 'image')
    ? `${resourceManager.resolveResourcePath(resourcePath)}/${variantId}.png`
    : null;

  const [imgError, setImgError] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="relative rounded-lg overflow-hidden transition-all"
      style={{
        aspectRatio: '1',
        border: selected
          ? '2px solid rgb(var(--primary))'
          : '1px solid var(--border)',
        background: isNone
          ? 'var(--secondary)'
          : 'var(--card-bg)',
        boxShadow: selected ? '0 0 12px rgba(var(--primary), 0.4)' : 'none',
        cursor: 'pointer',
      }}
    >
      {/* 预览图（image 类型） */}
      {previewUrl && !imgError && (
        <img
          src={previewUrl}
          alt={label}
          onError={() => setImgError(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            imageRendering: 'pixelated',
          }}
        />
      )}

      {/* 选中标记 */}
      {selected && (
        <div
          className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center z-10"
          style={{ background: 'rgb(var(--primary))' }}
        >
          <span style={{ color: 'white', fontSize: '9px', fontWeight: 'bold' }}>✓</span>
        </div>
      )}

      {/* 无选项的斜线纹理 */}
      {isNone && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(var(--primary), 0.08) 4px, rgba(var(--primary), 0.08) 8px)',
          }}
        >
          <span style={{ color: 'var(--text-50)', fontSize: '10px' }}>∅</span>
        </div>
      )}

      {/* 标签 */}
      <div
        className="absolute bottom-0 left-0 right-0 text-center py-0.5 text-[10px] font-medium truncate z-[5]"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
          color: selected ? 'white' : 'rgba(255,255,255,0.85)',
        }}
      >
        {label}
      </div>
    </button>
  );
}

// ===== 颜色选择器组件（用于 isColorable 部件） =====

// Hex 转 Hue（色相）
function hexToHue(hex: string): number {
  const r = parseInt(hex.substring(1, 3), 16) / 255;
  const g = parseInt(hex.substring(3, 5), 16) / 255;
  const b = parseInt(hex.substring(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / (max - min) * 60 + 360) % 360;
  else if (max === g) h = (b - r) / (max - min) * 60 + 120;
  else h = (r - g) / (max - min) * 60 + 240;
  return Math.round(h);
}

// 预设颜色（白/灰滑条选不出，彩色为快捷方式；均为明亮淡色调）
const PRESET_COLORS: string[] = [
  '#ffffff', '#cccccc',
  hslToHex(0, 60, 80), hslToHex(30, 60, 80), hslToHex(60, 60, 80),
  hslToHex(120, 60, 80), hslToHex(180, 60, 80), hslToHex(240, 60, 80),
  hslToHex(300, 60, 80),
];

interface ColorPickerProps {
  t: (key: string) => string;
  slots: string[];
  colors: Record<string, string>;
  onChange: (slotNames: string[], colorHex: string | null) => void;
}

function ColorPicker({ t, slots, colors, onChange }: ColorPickerProps) {
  // 从 slots 推导 Spine slot 名（"Base/Head" → "Head"）
  const slotNames = slots.map(s => s.split('/').pop() || s);
  // 当前颜色：取第一个 slot 的 colors 值
  const currentColor = slotNames.length > 0 ? (colors[slotNames[0]] || '') : '';
  const hue = currentColor ? hexToHue(currentColor) : 0;

  return (
    <div
      className="mb-3 p-2.5 rounded-lg border"
      style={{
        borderColor: 'var(--border)',
        backgroundColor: 'var(--secondary)',
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-50)' }}>
          {t('avatar.coloring')}
        </span>
        {/* 当前颜色色块 */}
        <div
          style={{
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            backgroundColor: currentColor || 'transparent',
            border: '1px solid var(--border)',
            boxShadow: currentColor ? '0 0 6px rgba(var(--primary), 0.3)' : 'none',
          }}
        />
        {currentColor && (
          <button
            type="button"
            onClick={() => onChange(slotNames, null)}
            className="text-[10px] px-1.5 py-0.5 rounded transition-opacity hover:opacity-80 ml-auto"
            style={{
              color: 'var(--text-50)',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--card-bg)',
            }}
          >
            {t('avatar.clear')}
          </button>
        )}
      </div>
      {/* 色相滑条（固定 saturation=80%, lightness=70%，确保明亮不暗） */}
      <input
        type="range"
        min={0}
        max={360}
        value={hue}
        onChange={(e) => {
          const h = parseInt(e.target.value, 10);
          onChange(slotNames, hslToHex(h, 60, 80));
        }}
        style={{
          width: '100%',
          height: '10px',
          appearance: 'none',
          WebkitAppearance: 'none',
          background:
            'linear-gradient(to right, hsl(0,60%,80%), hsl(60,60%,80%), hsl(120,60%,80%), hsl(180,60%,80%), hsl(240,60%,80%), hsl(300,60%,80%), hsl(360,60%,80%))',
          borderRadius: '5px',
          outline: 'none',
          cursor: 'pointer',
        }}
      />
      {/* 预设颜色按钮（含白/灰，滑条选不出） */}
      <div className="flex items-center gap-1.5 flex-wrap mt-2">
        {PRESET_COLORS.map((color) => {
          const isSelected = currentColor.toLowerCase() === color.toLowerCase();
          return (
            <button
              key={color}
              type="button"
              onClick={() => onChange(slotNames, color)}
              title={color}
              className="rounded-full transition-transform hover:scale-110"
              style={{
                width: '20px',
                height: '20px',
                backgroundColor: color,
                border: isSelected
                  ? '2px solid rgb(var(--primary))'
                  : '1px solid var(--border)',
                boxShadow: isSelected ? '0 0 6px rgba(var(--primary), 0.4)' : 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
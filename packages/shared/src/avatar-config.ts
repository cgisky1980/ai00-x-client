/**
 * 部位导向的 Avatar 配置类型定义与工具函数（三包共用）
 *
 * 资源按部位组织：{baseUrl}/parts/{partId}/{variantId}/{file}
 * 共享骨骼：{baseUrl}/skeleton/Characters.{json,atlas}
 * 配置文件：{baseUrl}/config.json
 *
 * 唯一实现点：packages/shared/src/avatar-config.ts
 * loader-ui / web-ui / underlay-ui 均从此处重导出，避免三份重复定义。
 */

// ── 部位定义（对应 config.json 里的 parts[]）──
export interface PartDef {
  partId: string;          // 'head' | 'body' | 'clothes' | 'hands' | 'legs' | 'eye' | 'glasses' | 'effects' | 'weapons'
  label: string;           // '头' | '身体' | '衣服' ...
  isColorable: boolean;    // 是否可调色（灰度图，文件名含 .c.）
  slots: string[];         // Spine slot/region 名，如 ['Base/Head']、['Base/Hand_F', 'Base/Hand_B']
  textureFiles: string[];  // 纹理文件名，如 ['head.c.png']、['hand_f.c.png', 'hand_b.c.png']
  variants: PartVariant[]; // 该部位的可用变体
  allowNone?: boolean;     // 是否允许"无"（隐藏该部位），如衣服/眼镜
  resourceType?: 'image';  // 资源类型：'image' = 单图模式（{resourcePath}/{variantId}.atlas）
  resourcePath?: string;   // 单图模式资源根路径（如 '/pet/heads'），由 ResourceManager 解析为可访问 URL
}

export interface PartVariant {
  variantId: string;       // 'default' | '3' | '5' | ...
  label: string;           // '默认(熊猫)' | '企鹅' | '小鸭' ...
}

// ── config.json 完整格式 ──
export interface AvatarConfigFile {
  version: string;
  description: string;
  parts: PartDef[];
  defaults: Record<string, string>;  // { head: '3', body: 'default', ... }
  defaultColors: Record<string, string>;  // { Body: '#f0f0f0', Head: '#f0f0f0', ... }
}

// ── 运行时选中状态 ──
export interface AvatarSelection {
  parts: Record<string, string>;   // { head: '3', body: 'default', tails: '3', ... }
  colors: Record<string, string>;  // { Body: '#3a4a5a', Head: '#3a4a5a', ... }
}

/** 根据 partId 查找部位定义 */
export function getPartDef(config: AvatarConfigFile, partId: string): PartDef | undefined {
  return config.parts.find(p => p.partId === partId);
}

/** HSL 转 Hex（用于生成明亮色调的随机颜色） */
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * 创建默认选中状态（从 config.json 的 defaults + defaultColors）
 * 对 isColorable 部件随机生成明亮色调颜色（避免每次进入都是白色）
 */
export function createDefaultSelection(config: AvatarConfigFile): AvatarSelection {
  const colors: Record<string, string> = { ...config.defaultColors };
  for (const part of config.parts) {
    if (part.isColorable) {
      const hue = Math.floor(Math.random() * 360);
      for (const slot of part.slots) {
        const slotName = slot.split('/').pop() || slot;
        colors[slotName] = hslToHex(hue, 60, 80);
      }
    }
  }
  return {
    parts: { ...config.defaults },
    colors,
  };
}
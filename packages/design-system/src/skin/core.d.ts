// 类型声明：src/skin/core.js（皮肤内核，构建与运行时共用）

export type SkinMode = 'dark' | 'light';
export type RequiredSeed = 'bg' | 'surface' | 'ink' | 'muted' | 'accent' | 'accentInk';
export type OptionalSeed = 'mark' | 'markInk' | 'success' | 'warning' | 'error' | 'info';
export type SeedKey = RequiredSeed | OptionalSeed;
export type SkinSeeds = Record<RequiredSeed, string> & Partial<Record<OptionalSeed, string>>;
export type FontId = 'geist' | 'system-sans' | 'system-serif' | 'geist-mono' | 'system-mono';
export type RadiusPreset = 'sharp' | 'soft' | 'round';
export type ButtonShape = 'solid' | 'pill' | 'tonal';
export type MotionLevel = 'full' | 'reduced';

/** 一份皮肤（.ai00skin.json 的规范化形态） */
export interface Skin {
  format: 1;
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** 来源说明（如 taste-skill 调色板 id） */
  source?: string;
  modes: Record<SkinMode, SkinSeeds>;
  type: { display: FontId; text: FontId; mono: FontId };
  shape: { radius: RadiusPreset; buttons: ButtonShape };
  motion: MotionLevel;
}

export interface SkinIssue {
  level: 'error' | 'warn';
  mode: SkinMode;
  pair: [string, string];
  label: string;
  ratio: number;
  min: number;
}

export const SKIN_FORMAT_VERSION: 1;
export const MODES: readonly SkinMode[];
export const REQUIRED_SEEDS: readonly RequiredSeed[];
export const OPTIONAL_SEEDS: readonly OptionalSeed[];
export const SEED_KEYS: readonly SeedKey[];
export const RADIUS_PRESETS: Record<RadiusPreset, Record<string, string>>;
export const BUTTON_SHAPES: readonly ButtonShape[];
export const MOTION_LEVELS: readonly MotionLevel[];
export const FONT_CATALOG: Record<FontId, { name: string; role: 'sans' | 'serif' | 'mono'; stack: string }>;
export const CONTRAST_RULES: ReadonlyArray<{ a: SeedKey; b: SeedKey; min: number; label: string }>;
export const SURFACE_MIN_GAP: number;
export const SCENE_MIN_GAP: number;
export const SURFACE_LADDER: readonly string[];

export function isHex(v: unknown): v is string;
export function hexToRgb(hex: string): [number, number, number];
export function rgbToHex(rgb: number[]): string;
export function hexToOklch(hex: string): [number, number, number];
export function oklchToHex(lch: [number, number, number]): string;
export function mixHex(a: string, b: string, t: number): string;
export function shiftLightness(hex: string, dL: number): string;
export function contrast(a: string, b: string): number;
export function nudgeToContrast(fg: string, bg: string, min: number): string | null;

export function parseSkin(raw: unknown): { skin: Skin | null; errors: string[] };
export function completeSeeds(seeds: SkinSeeds, mode: SkinMode): Record<SeedKey, string>;
export function checkSkin(skin: Skin): SkinIssue[];
export function checkSurfaceLadder(skin: Skin): SkinIssue[];
export function skinVars(skin: Skin, mode: SkinMode): Record<string, string>;
export function skinCss(skin: Skin, selector: string): string;
export function skinAttributes(skin: Skin): Record<'data-skin' | 'data-buttons' | 'data-radius' | 'data-motion', string>;

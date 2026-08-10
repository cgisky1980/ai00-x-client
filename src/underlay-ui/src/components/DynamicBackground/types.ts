/** Monitor layout info from Rust backend */
export interface MonitorInfo {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

/** Supported background preset types */
export type BackgroundType =
  | 'transparent'
  | 'video'
  | 'shader'
  | 'image'
  | 'gradient'
  | 'web';

/** Config for a single background slot */
export interface BackgroundSlot {
  type: BackgroundType;
  config: Record<string, unknown>;
}

/** Top-level background config */
export interface BackgroundConfig {
  mode: 'single' | 'per-monitor';
  default: BackgroundSlot;
  monitors?: Record<number, BackgroundSlot>;
}

/** Default background config — dark animated gradient */
export const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: 'single',
  default: {
    type: 'web',
    config: {
      src: 'https://rwkv.cn',
    },
  },
};
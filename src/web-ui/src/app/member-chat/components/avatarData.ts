/**
 * avatarData — member_profiles.avatar_data 双形态解析（2026-09-07 头像统一）
 *
 * - `data:image/*` 静态图（member-chat 设置页上传）
 * - AvatarSelection JSON（Spine 动画形象，loader/主应用形象编辑器保存的同一格式）
 * - 空/非法 → none（消费方回退首字）
 */
import type { AvatarSelection } from '@ai00-x/shared';

export type ParsedAvatarData =
  | { kind: 'none' }
  | { kind: 'image'; src: string }
  | { kind: 'spine'; selection: AvatarSelection };

export function parseAvatarData(data: string | null | undefined): ParsedAvatarData {
  if (!data) return { kind: 'none' };
  if (data.startsWith('data:image/')) return { kind: 'image', src: data };
  if (data.startsWith('{')) {
    try {
      const parsed = JSON.parse(data) as AvatarSelection;
      if (parsed && typeof parsed === 'object' && parsed.parts && typeof parsed.parts === 'object') {
        return { kind: 'spine', selection: parsed };
      }
    } catch {
      /* 非 JSON → none */
    }
  }
  return { kind: 'none' };
}

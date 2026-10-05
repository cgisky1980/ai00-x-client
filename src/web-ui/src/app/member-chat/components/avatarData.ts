/**
 * avatarData — member_profiles 头像出参多形态解析
 *
 * - `data:image/*` 静态图（member-chat 设置页上传）
 * - AvatarSelection JSON（Spine 动画形象，loader/主应用形象编辑器保存的同一格式）
 * - 独立 URL（迁移 037：`/api/v1/community/avatars/...` 相对路径或 http(s) 绝对地址）
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
  // 头像独立 URL（迁移 037）：相对路径或 http(s) 绝对地址 → 静态图分支
  if (data.startsWith('/') || /^https?:\/\//i.test(data)) {
    return { kind: 'image', src: data };
  }
  return { kind: 'none' };
}

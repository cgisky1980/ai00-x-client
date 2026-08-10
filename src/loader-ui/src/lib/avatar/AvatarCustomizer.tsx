/**
 * 统一实现见 packages/shared/src/avatar/AvatarCustomizer.tsx（@ai00-x/shared）。
 * 此处注入 loader-ui 的 t（默认 translation 命名空间）和 resourceManager，保持对旧导入路径的兼容。
 */
import { AvatarCustomizer as SharedAvatarCustomizer, type AvatarCustomizerProps, type AvatarValue } from '@ai00-x/shared';
import { useI18n } from '@/lib/i18n';
import { resourceManager } from './ResourceManager';

export type { AvatarValue };
export type { AvatarCustomizerProps };

export function AvatarCustomizer(props: Omit<AvatarCustomizerProps, 't' | 'resourceManager'>) {
  const { t } = useI18n();
  return <SharedAvatarCustomizer {...props} t={t} resourceManager={resourceManager} />;
}
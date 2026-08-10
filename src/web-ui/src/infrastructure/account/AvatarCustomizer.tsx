/**
 * 统一实现见 packages/shared/src/avatar/AvatarCustomizer.tsx（@ai00-x/shared）。
 * 此处注入 web-ui 的 t（settings/account 命名空间）和 resourceManager，保持对旧导入路径的兼容。
 */
import { AvatarCustomizer as SharedAvatarCustomizer, type AvatarCustomizerProps, type AvatarValue } from '@ai00-x/shared';
import { useTranslation } from 'react-i18next';
import { resourceManager } from './ResourceManager';

export type { AvatarValue };
export type { AvatarCustomizerProps };

export function AvatarCustomizer(props: Omit<AvatarCustomizerProps, 't' | 'resourceManager'>) {
  const { t } = useTranslation('settings/account');
  return <SharedAvatarCustomizer {...props} t={t} resourceManager={resourceManager} />;
}
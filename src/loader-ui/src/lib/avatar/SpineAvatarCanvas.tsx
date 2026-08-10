/**
 * 统一实现见 packages/shared/src/avatar/SpineAvatarCanvas.tsx（@ai00-x/shared）。
 * 此处注入 loader-ui 的 resourceManager（Rust KV 版），保持对旧导入路径的兼容。
 */
import { SpineAvatarCanvas as SharedSpineAvatarCanvas, type SpineAvatarCanvasProps } from '@ai00-x/shared';
import { resourceManager } from './ResourceManager';

export default function SpineAvatarCanvas(
  props: Omit<SpineAvatarCanvasProps, 'resourceManager'>,
) {
  return <SharedSpineAvatarCanvas {...props} resourceManager={resourceManager} />;
}
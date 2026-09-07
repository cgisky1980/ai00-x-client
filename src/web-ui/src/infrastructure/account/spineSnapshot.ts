/**
 * spineSnapshot — Spine 形象离屏快照（能力层，无 React）
 *
 * 离屏渲一帧 PNG data URL：保存形象时固化到服务端 avatar_snapshot（迁移 029），
 * 列表/消息出参快照优先直显，避免每个查看者每次会话重复渲染。
 * 与 SpineAvatarCanvas 同规则：衣服固定隐藏（产品决定）。
 */
import { resourceManager } from './ResourceManager';
import { createLogger } from '@/shared/utils/logger';
import type { AvatarSelection, PartDef } from '@ai00-x/shared';

const log = createLogger('spineSnapshot');

let partDefsPromise: Promise<PartDef[]> | null = null;

/** 形象部件定义（SpineAvatarCanvas/MemberAvatar 编辑态共用） */
export function loadPartDefs(): Promise<PartDef[]> {
  if (!partDefsPromise) {
    partDefsPromise = resourceManager
      .init()
      .then(() => fetch(resourceManager.getConfigUrl()))
      .then((resp) => {
        if (!resp.ok) throw new Error(`avatar config HTTP ${resp.status}`);
        return resp.json() as Promise<{ parts: PartDef[] }>;
      })
      .then((config) => config.parts);
  }
  return partDefsPromise;
}

/** 离屏渲一帧 PNG 快照（保存形象时固化用，列表显示走服务端 avatar_snapshot） */
export async function renderSpineSnapshot(
  selection: AvatarSelection,
): Promise<string | null> {
  try {
    const [{ SpineAvatarRenderer }, partDefs] = await Promise.all([
      import('@ai00-x/shared'),
      loadPartDefs(),
    ]);
    // 与 SpineAvatarCanvas 同规则：衣服固定隐藏（产品决定）
    const effective: AvatarSelection = {
      ...selection,
      parts: { ...selection.parts, clothes: 'none' },
    };
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const renderer = new SpineAvatarRenderer(canvas);
    try {
      await renderer.loadSkeletonWithParts(
        effective,
        partDefs,
        resourceManager.getSkeletonPath(),
        resourceManager.getPartsPath(),
        'default',
        (p) => resourceManager.resolveResourcePath(p),
      );
      // 等两帧确保首帧绘制完成
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return canvas.toDataURL('image/png');
    } finally {
      renderer.destroy();
    }
  } catch (error) {
    log.warn('Spine avatar snapshot failed, fallback to initial', error);
    return null;
  }
}

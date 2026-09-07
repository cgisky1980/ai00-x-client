/**
 * MemberAvatar — 成员头像统一入口（member-chat/社区全部头像消费点走这里）
 *
 * avatar_data 为双形态字段（服务端 validate_avatar_data 同时放行两种格式，解析见 avatarData.ts）：
 * - `data:image/*` 静态图 → 直接走 design-system Avatar
 * - AvatarSelection JSON（Spine 动画形象）
 *   · 默认（列表/消息流）：离屏渲一帧 PNG 快照，会话级内存缓存，无常驻运行时开销
 *   · animated（个人主页头部等低密度场景）：实时 Spine canvas
 * - 空/解析失败/资源加载失败 → 首字回退；快照失败会话内不重试（/pet 资产与聊天 API 同源，
 *   服务器可达性一致，避免列表反复打资源请求）
 *
 * Spine 运行时（PIXI）经动态加载，不进 member-chat 首屏 chunk。
 */
import React from 'react';
import { Avatar } from '@/component-library';
import { loadPartDefs, renderSpineSnapshot } from '@/infrastructure/account/spineSnapshot';
import { createLogger } from '@/shared/utils/logger';
import { parseAvatarData } from './avatarData';
import type { AvatarSelection, PartDef } from '@ai00-x/shared';

const log = createLogger('MemberAvatar');

type AvatarSize = 'sm' | 'base' | 'lg' | 'xl';

/* ---------------- Spine 快照（离屏渲一帧，会话级缓存） ---------------- */

const snapshotCache = new Map<string, Promise<string | null>>();

function getSnapshot(data: string, selection: AvatarSelection): Promise<string | null> {
  let entry = snapshotCache.get(data);
  if (!entry) {
    entry = renderSpineSnapshot(selection);
    snapshotCache.set(data, entry);
  }
  return entry;
}

/* ---------------- 子组件（先于主组件定义） ---------------- */

/** 快照态：等快照就绪前先显示首字 */
const MemberSpineSnapshot: React.FC<{
  dataKey: string;
  selection: AvatarSelection;
  name?: string;
  size: AvatarSize;
  className?: string;
}> = ({ dataKey, selection, name, size, className }) => {
  const [src, setSrc] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setSrc(null);
    getSnapshot(dataKey, selection).then((url) => {
      if (alive && url) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [dataKey, selection]);

  return <Avatar src={src ?? undefined} name={name} size={size} className={className} />;
};

/** 实时动画态：React.lazy 保持 PIXI 在按需 chunk */
const LiveSpineCanvas = React.lazy(() => import('@/infrastructure/account/SpineAvatarCanvas'));

const MemberSpineLive: React.FC<{
  selection: AvatarSelection;
  name?: string;
  size: AvatarSize;
  className?: string;
}> = ({ selection, name, size, className }) => {
  const [partDefs, setPartDefs] = React.useState<PartDef[] | null>(null);

  React.useEffect(() => {
    let alive = true;
    loadPartDefs()
      .then((defs) => {
        if (alive) setPartDefs(defs);
      })
      .catch((error) => log.warn('avatar partDefs load failed', error));
    return () => {
      alive = false;
    };
  }, []);

  if (!partDefs) {
    return <Avatar name={name} size={size} className={className} />;
  }

  return (
    <span className={`member-avatar-live member-avatar-live--${size}${className ? ` ${className}` : ''}`}>
      <React.Suspense fallback={null}>
        <LiveSpineCanvas selection={selection} partDefs={partDefs} />
      </React.Suspense>
    </span>
  );
};

/* ---------------- 主组件 ---------------- */

export interface MemberAvatarProps {
  /** avatar_data 原文（sender_avatar / post.avatar / home.avatar 等透传值） */
  data?: string | null;
  /** 首字回退显示名 */
  name?: string;
  size?: AvatarSize;
  /** 实时渲染 Spine 动画（主页头部等低密度场景）；默认快照 */
  animated?: boolean;
  className?: string;
}

export const MemberAvatar: React.FC<MemberAvatarProps> = ({
  data,
  name,
  size = 'base',
  animated = false,
  className,
}) => {
  const parsed = parseAvatarData(data);

  if (parsed.kind !== 'spine') {
    return (
      <Avatar
        src={parsed.kind === 'image' ? parsed.src : undefined}
        name={name}
        size={size}
        className={className}
      />
    );
  }

  if (animated) {
    return <MemberSpineLive selection={parsed.selection} name={name} size={size} className={className} />;
  }
  return (
    <MemberSpineSnapshot
      dataKey={data ?? ''}
      selection={parsed.selection}
      name={name}
      size={size}
      className={className}
    />
  );
};

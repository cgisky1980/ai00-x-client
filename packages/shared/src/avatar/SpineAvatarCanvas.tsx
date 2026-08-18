import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SpineAvatarRenderer } from './SpineAvatarRenderer';
import type { AvatarSelection, PartDef } from '../avatar-config';
import type { AvatarResourceManager } from '../avatar-resource';

export interface SpineAvatarCanvasProps {
  selection: AvatarSelection;
  partDefs: PartDef[];
  /** 资源管理器（由各包注入，负责 baseUrl 与存储） */
  resourceManager: AvatarResourceManager;
  animation?: string;
  className?: string;
  /** 已废弃：现在 canvas 会自动填满父容器，width/height 不再生效 */
  width?: number;
  height?: number;
}

/**
 * Spine 头像预览 Canvas（部位导向架构）
 *
 * 加载流程：
 * 1. 初始化 ResourceManager（拉服务器 manifest，失败降级用 public/）
 * 2. 用 loadSkeletonWithParts 加载（共享 skeleton + 按部位 variant atlas 替换）
 * 3. selection 变化时重新加载
 * 4. animation 变化时调用 setAnimation
 * 5. ResizeObserver 监听父容器尺寸变化，自动 resize canvas
 *
 * 唯一实现点：packages/shared/src/avatar/SpineAvatarCanvas.tsx
 * loader-ui / web-ui 均作为薄封装注入各自 resourceManager 后复用。
 */
export default function SpineAvatarCanvas({
  selection,
  partDefs,
  resourceManager,
  animation,
  className,
}: SpineAvatarCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpineAvatarRenderer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // selection.parts 变化时重新加载 skeleton（colors 变化不触发重载）
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // 初始化 canvas 尺寸为父容器尺寸
    const rect = container.getBoundingClientRect();
    const initW = Math.max(100, Math.floor(rect.width));
    const initH = Math.max(100, Math.floor(rect.height));
    canvas.width = initW;
    canvas.height = initH;

    const renderer = new SpineAvatarRenderer(canvas);
    rendererRef.current = renderer;
    setLoading(true);
    setError(null);

    // 衣服暂时固定为"无"（产品决定）：无论 avatar_data 里存了什么，渲染时不显示衣服
    const effectiveSelection: AvatarSelection = {
      ...selection,
      parts: { ...selection.parts, clothes: 'none' },
    };

    resourceManager
      .init()
      .then(() => {
        const skeletonPath = resourceManager.getSkeletonPath();
        const partsPath = resourceManager.getPartsPath();
        return renderer.loadSkeletonWithParts(
          effectiveSelection,
          partDefs,
          skeletonPath,
          partsPath,
          'default',
          (resourcePath) => resourceManager.resolveResourcePath(resourcePath),
        );
      })
      .then(() => {
        setLoading(false);
        if (animation) {
          renderer.setAnimation(animation);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : '加载失败');
        setLoading(false);
      });

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.parts, partDefs, resourceManager]);

  // selection.colors 变化时只更新颜色（不重新加载 skeleton，避免卡顿）
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || loading) return;
    renderer.updateColors(selection.colors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.colors, loading]);

  // 父容器尺寸变化时 resize canvas
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          const renderer = rendererRef.current;
          if (renderer) {
            renderer.resize(Math.floor(width), Math.floor(height));
          } else {
            // renderer 还没初始化，直接设 canvas 尺寸
            canvas.width = Math.floor(width);
            canvas.height = Math.floor(height);
          }
        }
      }
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // animation 变化时切换动画
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !animation || loading) return;
    renderer.setAnimation(animation);
  }, [animation, loading]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgb(var(--primary))',
          }}
        >
          <Loader2 className="w-8 h-8 animate-spin" style={{ animationDuration: '1.2s' }} />
        </div>
      )}
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--destructive, #f00)',
            fontSize: '12px',
            padding: '8px',
            textAlign: 'center',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
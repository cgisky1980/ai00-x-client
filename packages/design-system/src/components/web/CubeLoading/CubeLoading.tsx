import React from 'react';
import { BrandMark } from '../../brand-mark';

export type CubeLoadingSize = 'small' | 'medium' | 'large';

export interface CubeLoadingProps {
  /** Size: small(24px) | medium(40px) | large(60px) */
  size?: CubeLoadingSize;
  /** Loading text */
  text?: string;
  /** Custom class name */
  className?: string;
}

const sizeMap: Record<CubeLoadingSize, number> = {
  small: 24,
  medium: 40,
  large: 60,
};

/**
 * 灵印 Loading——与 BrandMark 同字形（镂空圆脸擦 X，四角冒头）：
 * 圆环呼吸 + 双眼眨眼，X 静止为骨（规范 2.5 灵韵态）。
 * LOGO 与 loading 动画同源同形，品牌资产二合一。
 */
export const CubeLoading: React.FC<CubeLoadingProps> = ({
  size = 'medium',
  text,
  className = '',
}) => {
  return (
    <div
      className={`cube-loading cube-loading--${size} ${className}`}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}
    >
      <BrandMark animated size={sizeMap[size]} />
      {text && <div className="cube-loading__text">{text}</div>}
    </div>
  );
};

CubeLoading.displayName = 'CubeLoading';

export default CubeLoading;

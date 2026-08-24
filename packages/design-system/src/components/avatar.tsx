/**
 * Avatar —— Radix Avatar 封装（规范 5.8）；圆形，失败回退墨阶圆底+首字
 */
import { forwardRef } from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '../lib/cn';

export interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
  src?: string;
  alt?: string;
  /** 用于回退首字（取第一个字符） */
  name?: string;
  size?: 'sm' | 'base' | 'lg' | 'xl';
}

const sizeClass = {
  sm: 'ds-avatar--sm',
  base: 'ds-avatar--base',
  lg: 'ds-avatar--lg',
  xl: 'ds-avatar--xl',
} as const;

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(
  ({ className, src, alt, name, size = 'base', ...props }, ref) => (
    <AvatarPrimitive.Root ref={ref} className={cn('ds-avatar', sizeClass[size], className)} {...props}>
      {src && <AvatarPrimitive.Image src={src} alt={alt ?? ''} className="ds-avatar__image" />}
      <AvatarPrimitive.Fallback className="ds-avatar__fallback" delayMs={200}>
        {name?.trim()?.charAt(0) ?? '?'}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  ),
);
Avatar.displayName = 'Avatar';

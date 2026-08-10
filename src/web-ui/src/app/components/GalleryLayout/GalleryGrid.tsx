import React from 'react';

interface GalleryGridProps {
  children: React.ReactNode;
  minCardWidth?: number;
  className?: string;
}

const GalleryGrid: React.FC<GalleryGridProps> = ({
  children,
  minCardWidth = 320,
  className,
}) => (
  <div
    className={['gallery-grid', className].filter(Boolean).join(' ')}
    style={{ '--gallery-grid-min': `${minCardWidth}px` } as React.CSSProperties}
  >
    {children}
  </div>
);

export default GalleryGrid;
export type { GalleryGridProps };

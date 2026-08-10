import React from 'react';

interface GalleryEmptyProps {
  icon: React.ReactNode;
  message: React.ReactNode;
  isError?: boolean;
  action?: React.ReactNode;
  className?: string;
}

const GalleryEmpty: React.FC<GalleryEmptyProps> = ({
  icon,
  message,
  isError = false,
  action,
  className,
}) => (
  <div className={['gallery-empty', isError && 'gallery-empty--error', className].filter(Boolean).join(' ')}>
    {icon}
    <span>{message}</span>
    {action}
  </div>
);

export default GalleryEmpty;
export type { GalleryEmptyProps };

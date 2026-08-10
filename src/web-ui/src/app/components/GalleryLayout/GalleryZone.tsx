import React from 'react';

interface GalleryZoneProps {
  id?: string;
  title: string;
  subtitle?: React.ReactNode;
  tools?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const GalleryZone: React.FC<GalleryZoneProps> = ({
  id,
  title,
  subtitle,
  tools,
  children,
  className,
}) => (
  <section id={id} className={['gallery-zone', className].filter(Boolean).join(' ')}>
    <div className="gallery-zone__header">
      <div className="gallery-zone__heading">
        <span className="gallery-zone__title">{title}</span>
        {subtitle ? <span className="gallery-zone__subtitle">{subtitle}</span> : null}
      </div>
      {tools ? <div className="gallery-zone__tools">{tools}</div> : null}
    </div>
    {children}
  </section>
);

export default GalleryZone;
export type { GalleryZoneProps };

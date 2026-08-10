import React from 'react';

interface Props {
  style: React.CSSProperties;
}

/** Default solid background — dark base matching theme */
export function TransparentBackground({ style }: Props) {
  return <div style={{ ...style, background: '#0f0c29' }} />;
}
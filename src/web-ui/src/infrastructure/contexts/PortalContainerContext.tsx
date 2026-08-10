/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext } from 'react';

/**
 * Provides a container element inside the overlay panel for portals.
 * All popups, dialogs, tooltips, etc. should portal into this container
 * so they render inside the overlay panel and remain interactive.
 */
const PortalContainerContext = createContext<HTMLElement | null>(null);

export const PortalContainerProvider: React.FC<{
  container: HTMLElement | null;
  children: React.ReactNode;
}> = ({ container, children }) => (
  <PortalContainerContext.Provider value={container}>
    {children}
  </PortalContainerContext.Provider>
);

export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}

 

import React from 'react';
import { createPortal } from 'react-dom';
import * as LucideIcons from 'lucide-react';
import { ContextMenu } from './ui/ContextMenu';
import { useContextMenuStore } from '../store/ContextMenuStore';
import { MenuItem as SystemMenuItem } from '../types/menu.types';
import { ContextMenuItem as UIMenuItem } from './ui/types';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';

 
function getIconComponent(icon: any): string | React.ReactNode | undefined {
  if (!icon) return undefined;
  
  
  if (React.isValidElement(icon)) {
    return icon;
  }
  
  
  if (typeof icon === 'string') {
    const IconComponent = (LucideIcons as any)[icon];
    if (IconComponent) {
      return React.createElement(IconComponent, { size: 16 });
    }
    
    return icon;
  }
  
  return undefined;
}

 
function convertMenuItem(item: SystemMenuItem): UIMenuItem {
  return {
    id: item.id,
    label: item.label,
    icon: getIconComponent(item.icon),
    disabled: typeof item.disabled === 'boolean' ? item.disabled : false,
    separator: item.separator,
    shortcut: item.shortcut,
    submenu: item.submenu?.map(convertMenuItem),
    onClick: item.onClick
  };
}

 
export const ContextMenuRenderer: React.FC = () => {
  const { visible, position, items, context, hideMenu } = useContextMenuStore();
  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;

  const uiItems = items.map(convertMenuItem);

  if (!visible) {
    return null;
  }

  return createPortal(
    <ContextMenu
      items={uiItems}
      position={position || { x: 0, y: 0 }}
      visible={visible}
      context={context || undefined}
      onClose={hideMenu}
    />,
    portalTarget
  );
};

export default ContextMenuRenderer;


 

import { contextMenuManager, ContextMenuManager } from './ContextMenuManager';
import { contextMenuRegistry } from './ContextMenuRegistry';
import { IMenuProvider, MenuProviderConfig } from '../types/provider.types';
import { MenuItem } from '../types/menu.types';
import { MenuContext } from '../types/context.types';

 
export class ContextMenuController {
  private manager: ContextMenuManager;

  constructor(manager?: ContextMenuManager) {
    this.manager = manager || contextMenuManager;
  }

   
  async show(
    position: { x: number; y: number },
    items: MenuItem[],
    context?: Partial<MenuContext>
  ): Promise<void> {
    await this.manager.showMenu(position, items, context);
  }

   
  async hide(): Promise<void> {
    await this.manager.hide();
  }

   
  registerProvider(provider: IMenuProvider | MenuProviderConfig): void {
    contextMenuRegistry.register(provider);
  }

   
  unregisterProvider(providerId: string): boolean {
    return contextMenuRegistry.unregister(providerId);
  }

   
  setProviderEnabled(providerId: string, enabled: boolean): void {
    contextMenuRegistry.setProviderEnabled(providerId, enabled);
  }

   
  getManager(): ContextMenuManager {
    return this.manager;
  }

   
  getCurrentContext(): MenuContext | null {
    return this.manager.getCurrentContext();
  }
}

 
export const contextMenuController = new ContextMenuController();


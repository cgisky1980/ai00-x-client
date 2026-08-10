 

import { BaseCommand } from '../../BaseCommand';
import { CommandResult } from '../../../types/command.types';
import { MenuContext, ContextType, FileNodeContext } from '../../../types/context.types';
import { i18nService } from '@/infrastructure/i18n';

export class CopyPathCommand extends BaseCommand {
  constructor() {
    const t = i18nService.getT();
    super({
      id: 'file.copy-path',
      label: t('common:file.copyPath'),
      description: t('common:contextMenu.descriptions.copyPath'),
      icon: 'Copy',
      category: 'file'
    });
  }

  canExecute(context: MenuContext): boolean {
    return context.type === ContextType.FILE_NODE || 
           context.type === ContextType.FOLDER_NODE;
  }

  async execute(context: MenuContext): Promise<CommandResult> {
    try {
      const t = i18nService.getT();
      const fileContext = context as FileNodeContext;
      
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(fileContext.filePath);
      } else {
        
        const textarea = document.createElement('textarea');
        textarea.value = fileContext.filePath;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      return this.success(t('common:contextMenu.status.copyPathSuccess'), { path: fileContext.filePath });
    } catch (error) {
      const t = i18nService.getT();
      return this.failure(t('errors:contextMenu.copyPathFailed'), error as Error);
    }
  }
}


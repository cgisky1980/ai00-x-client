export * from './types';
export * from './services';
export * from './hooks';
export * from './components';
export { GitStateManager, gitStateManager } from './state';

import { workspaceGitInitializer } from './services/WorkspaceGitInitializer';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('Git');

/**
 * Initialize Git module and start monitoring workspace changes
 */
export function initializeGit(): void {
  try {
    workspaceGitInitializer.start();
    log.info('Git module initialized');
  } catch (error) {
    log.error('Failed to initialize Git module', { error });
  }
}

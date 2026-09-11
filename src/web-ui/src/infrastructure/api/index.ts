/**
 * Ai00-X API unified exports.
 *
 * Follows the Ai00-X Tauri command conventions.
 */

export * from './service-api/types';
export * from './service-api/ApiClient';
export * from './service-api/tauri-commands';
export * from './service-api/AIApi';

// Import API modules
import { workspaceAPI } from './service-api/WorkspaceAPI';
import { configAPI } from './service-api/ConfigAPI';
import { aiApi } from './service-api/AIApi';
import { systemAPI } from './service-api/SystemAPI';
import { diffAPI } from './service-api/DiffAPI';
import { globalAPI } from './service-api/GlobalAPI';
import { contextAPI } from './service-api/ContextAPI';
import { gitAPI } from './service-api/GitAPI';
import { gitRepoHistoryAPI, type GitRepoHistory } from './service-api/GitRepoHistoryAPI';
import { i18nAPI } from './service-api/I18nAPI';
import { editorAiAPI } from './service-api/EditorAiAPI';
import { translateApi } from './service-api/TranslateApi';

// Export API modules
export { workspaceAPI, configAPI, aiApi, systemAPI, diffAPI, globalAPI, contextAPI, gitAPI, gitRepoHistoryAPI, i18nAPI, editorAiAPI, translateApi };

// Export types
export type { GitRepoHistory };

// Ai00-X API collection: a single access point for all API modules.
export const ai00xAPI = {
  workspace: workspaceAPI,
  config: configAPI,
  ai: aiApi,
  system: systemAPI,
  diff: diffAPI,
  global: globalAPI,
  context: contextAPI,
  git: gitAPI,
  gitRepoHistory: gitRepoHistoryAPI,
  i18n: i18nAPI,
  editorAi: editorAiAPI,
  translate: translateApi,
};

// Default export
export default ai00xAPI;

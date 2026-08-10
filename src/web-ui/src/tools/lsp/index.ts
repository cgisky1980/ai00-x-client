/**
 * LSP module exports and initialization helpers.
 */

// Services
export { lspService, LspService } from './services/LspService';
export { MonacoLspAdapter, GlobalAdapterRegistry } from './services/MonacoLspAdapter';
export { lspAdapterManager } from './services/LspAdapterManager';
export { WorkspaceLspManager } from './services/WorkspaceLspManager';
export { workspaceLspInitializer } from './services/WorkspaceLspInitializer';
export { LspDiagnostics } from './services/LspDiagnostics';
export { HoverPositionCalculator } from './services/HoverPositionCalculator';
export { lspDocumentService } from './services/LspDocumentService';
export { lspExtensionRegistry } from './services/LspExtensionRegistry';
export type { SupportedExtensionsResponse } from './services/LspExtensionRegistry';
export { lspRefreshManager, LspRefreshManager } from './services/LspRefreshManager';

export type { PositionCalculatorOptions, PositionResult } from './services/HoverPositionCalculator';

// Hooks
export { useLspPlugins, useLspInit } from './hooks/useLsp';
export { useMonacoLsp } from './hooks/useMonacoLsp';

// Components
export { LspPluginList } from './components/LspPluginList/LspPluginList';
export type { LspPluginListProps } from './components/LspPluginList/LspPluginList';

// Types
export type {
  LspPlugin,
  ServerConfig,
  CapabilitiesConfig,
  CompletionItem,
  Position,
  Range,
  Diagnostic,
  HoverInfo,
  Location,
  TextEdit,
} from './types';

export { CompletionItemKind, DiagnosticSeverity } from './types';
export { lspConfigService } from './services/LspConfigService';

// Initialization
import { workspaceLspInitializer } from './services/WorkspaceLspInitializer';
import { MonacoLspAdapter, GlobalAdapterRegistry } from './services/MonacoLspAdapter';
import { lspExtensionRegistry } from './services/LspExtensionRegistry';
import './services/LspDiagnostics'; // side-effect: registers global diagnostics helpers

import { createLogger } from '@/shared/utils/logger';

const log = createLogger('LSP');

export async function initializeLsp(): Promise<void> {
  try {
    await lspExtensionRegistry.initialize();
    workspaceLspInitializer.start();
    installLspDiagnosticTools();
  } catch (error) {
    log.error('Failed to initialize LSP module', { error });
  }
}

/**
 * Install a small set of global diagnostic helpers for debugging.
 *
 * Exposes `window.LspDiag` with methods like `.check()` and `.testDiagnostics()`.
 */
function installLspDiagnosticTools() {
  const lspDiag = {
    enable() {
      MonacoLspAdapter.enableDiagnosticMode();
    },
    
    disable() {
      MonacoLspAdapter.disableDiagnosticMode();
    },
    
    check() {
      const monaco = (window as any).monaco;
      if (!monaco) {
        log.error('Monaco Editor not loaded');
        return;
      }
      
      const languages = monaco.languages.getLanguages().map((l: any) => l.id);
      const adapters = GlobalAdapterRegistry.adapters;
      const adapterUris = Array.from(adapters.keys());
      
      log.info('LSP status check', {
        registeredLanguages: languages.length,
        languages,
        activeAdapters: adapters.size,
        adapterUris
      });
      
      for (const [, adapter] of adapters.entries()) {
        (adapter as any).getDiagnosticInfo?.();
      }
    },
    
    async testInlayHints() {
      const adapters = GlobalAdapterRegistry.adapters;
      if (adapters.size === 0) {
        log.warn('No active LSP Adapter');
        return;
      }
      
      const adapter = adapters.values().next().value;
      const model = (adapter as any).model;
      const range = new (window as any).monaco.Range(1, 1, model.getLineCount(), 1);
      
      try {
        const result = await (adapter as any).provideInlayHints(model, range);
        
        if (result.hints && result.hints.length > 0) {
          const hintPositions = result.hints.slice(0, 5).map((hint: any, i: number) => {
            const labelText = typeof hint.label === 'string' 
              ? hint.label 
              : hint.label.map((p: any) => p.label || p.value).join('');
            return {
              index: i + 1,
              line: hint.position.lineNumber,
              label: labelText
            };
          });
          
          log.info('Inlay Hints test result', {
            hintCount: result.hints.length,
            hintPositions,
            moreHints: result.hints.length > 5 ? result.hints.length - 5 : 0,
            note: 'Monaco Editor may not display them automatically',
            reasons: [
              'Editor needs to be active',
              'Viewport needs to include hint lines',
              'Monaco version needs to support it'
            ]
          });
        }
      } catch (error) {
        log.error('Inlay Hints test failed', { error });
      }
    },
    
    async forceRefreshInlayHints() {
      const monaco = (window as any).monaco;
      if (!monaco) {
        log.error('Monaco not loaded');
        return;
      }
      
      const adapters = GlobalAdapterRegistry.adapters;
      if (adapters.size === 0) {
        log.warn('No active LSP Adapter');
        return;
      }
      
      for (const [uri, adapter] of adapters.entries()) {
        try {
          const editor = (adapter as any).editor;
          if (!editor) {
            continue;
          }
          
          const action = editor.getAction('editor.action.inlayHints.refresh');
          if (action) {
            action.run();
          }
        } catch (error) {
          log.error('Failed to refresh inlay hints', { uri, error });
        }
      }
    },
    
    testDiagnostics() {
      const monaco = (window as any).monaco;
      if (!monaco) {
        log.error('Monaco not loaded');
        return;
      }
      
      const models = monaco.editor.getModels();
      const documents = models.map((model: any, i: number) => {
        const markers = monaco.editor.getModelMarkers({ resource: model.uri });
        const lspMarkers = markers.filter((m: any) => m.source === 'lsp');
        
        return {
          index: i + 1,
          uri: model.uri.toString(),
          language: model.getLanguageId(),
          lineCount: model.getLineCount(),
          totalMarkers: markers.length,
          lspMarkers: lspMarkers.length > 0 ? lspMarkers.map((m: any, j: number) => ({
            index: j + 1,
            line: m.startLineNumber,
            severity: m.severity,
            message: m.message
          })) : []
        };
      });
      
      log.info('Diagnostics test', {
        documentCount: models.length,
        documents
      });
    },
    
    help() {
      const commands = [
        { command: '.enable()', description: 'Enable verbose logging' },
        { command: '.disable()', description: 'Disable verbose logging' },
        { command: '.check()', description: 'Check LSP system status' },
        { command: '.testInlayHints()', description: 'Test Inlay Hints' },
        { command: '.forceRefreshInlayHints()', description: 'Force refresh Inlay Hints' },
        { command: '.testDiagnostics()', description: 'Test diagnostics' },
        { command: '.help()', description: 'Show this help' }
      ];
      
      log.info('LSP Diagnostic Tools Help', { commands });
    }
  };
  
  (window as any).LspDiag = lspDiag;
}

 

import { contextAPI } from '../../api';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ContextManager');


export type { ContextStats, SessionMetadata, StorageStats } from '../../api/service-api/ContextAPI';
import type { ContextStats, SessionMetadata, StorageStats } from '../../api/service-api/ContextAPI';

export class ContextManager {
   
  async compressContext(): Promise<string> {
    try {
      return await contextAPI.compressContext();
    } catch (error) {
      log.error('Failed to compress context', error);
      throw new Error(`Context compression failed: ${error}`);
    }
  }

   
  async getContextStats(): Promise<ContextStats> {
    try {
      return await contextAPI.getContextStats();
    } catch (error) {
      log.error('Failed to get context stats', error);
      throw new Error(`Failed to get context stats: ${error}`);
    }
  }

   
  async clearContext(): Promise<string> {
    try {
      return await contextAPI.clearContext();
    } catch (error) {
      log.error('Failed to clear context', error);
      throw new Error(`Context clear failed: ${error}`);
    }
  }

   
  async saveSessionData(sessionData: any): Promise<string> {
    try {
      return await contextAPI.saveSessionData(sessionData);
    } catch (error) {
      log.error('Failed to save session data', error);
      throw new Error(`Task save failed: ${error}`);
    }
  }

   
  async loadSessionData(sessionId: string): Promise<any> {
    try {
      return await contextAPI.loadSessionData(sessionId);
    } catch (error) {
      log.error('Failed to load session data', { sessionId, error });
      throw new Error(`Task load failed: ${error}`);
    }
  }

   
  async listSessions(includeArchived: boolean = false): Promise<SessionMetadata[]> {
    try {
      return await contextAPI.listSessions(includeArchived);
    } catch (error) {
      log.error('Failed to list sessions', { includeArchived, error });
      throw new Error(`Failed to list tasks: ${error}`);
    }
  }

   
  async searchSessions(query: string, tags?: string[]): Promise<SessionMetadata[]> {
    try {
      return await contextAPI.searchSessions(query, tags);
    } catch (error) {
      log.error('Failed to search sessions', { query, tags, error });
      throw new Error(`Failed to search tasks: ${error}`);
    }
  }

   
  async deleteSession(sessionId: string): Promise<string> {
    try {
      return await contextAPI.deleteSession(sessionId);
    } catch (error) {
      log.error('Failed to delete session', { sessionId, error });
      throw new Error(`Failed to delete task: ${error}`);
    }
  }

   
  async archiveSession(sessionId: string): Promise<string> {
    try {
      return await contextAPI.archiveSession(sessionId);
    } catch (error) {
      log.error('Failed to archive session', { sessionId, error });
      throw new Error(`Failed to archive task: ${error}`);
    }
  }

   
  async exportSession(sessionId: string, exportPath: string): Promise<string> {
    try {
      return await contextAPI.exportSession(sessionId, exportPath);
    } catch (error) {
      log.error('Failed to export session', { sessionId, exportPath, error });
      throw new Error(`Failed to export task: ${error}`);
    }
  }

   
  async importSession(importPath: string): Promise<string> {
    try {
      return await contextAPI.importSession(importPath);
    } catch (error) {
      log.error('Failed to import session', { importPath, error });
      throw new Error(`Failed to import task: ${error}`);
    }
  }

   
  async getStorageStats(): Promise<StorageStats> {
    try {
      return await contextAPI.getStorageStats();
    } catch (error) {
      log.error('Failed to get storage stats', error);
      throw new Error(`Failed to get storage stats: ${error}`);
    }
  }
}


export const contextManager = new ContextManager();


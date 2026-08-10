 

import { useState, useEffect, useCallback } from 'react';
import {
  AIRulesAPI,
  type AIRule,
  RuleLevel,
  type RuleStats,
  type CreateRuleRequest,
  type UpdateRuleRequest,
} from '../api/service-api/AIRulesAPI';
import { useCurrentWorkspace } from '../contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { useI18n } from '@/infrastructure/i18n';

const log = createLogger('useAIRules');

export interface UseAIRulesReturn {
  
  rules: AIRule[];
  stats: RuleStats | null;

  
  isLoading: boolean;
  error: string | null;

  
  createRule: (rule: CreateRuleRequest) => Promise<AIRule>;
  updateRule: (name: string, rule: UpdateRuleRequest) => Promise<AIRule>;
  deleteRule: (name: string) => Promise<boolean>;
  toggleRule: (name: string) => Promise<AIRule>;
  
  
  refresh: () => Promise<void>;
}

 
export function useAIRules(level: RuleLevel): UseAIRulesReturn {
  const { t } = useI18n('errors');
  const { workspacePath } = useCurrentWorkspace();
  const [rules, setRules] = useState<AIRule[]>([]);
  const [stats, setStats] = useState<RuleStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopedWorkspacePath = level === RuleLevel.Project ? workspacePath || undefined : undefined;

  
  const loadRules = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await AIRulesAPI.getRules(level, scopedWorkspacePath);
      setRules(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aiRules.loadFailed'));
      log.error('Failed to load rules', err);
    } finally {
      setIsLoading(false);
    }
  }, [level, scopedWorkspacePath, t]);

  
  const loadStats = useCallback(async () => {
    try {
      const data = await AIRulesAPI.getRulesStats(level, scopedWorkspacePath);
      setStats(data);
    } catch (err) {
      log.error('Failed to load stats', err);
    }
  }, [level, scopedWorkspacePath]);

  
  const createRule = useCallback(
    async (request: CreateRuleRequest) => {
      try {
        setError(null);
        const newRule = await AIRulesAPI.createRule(level, request, scopedWorkspacePath);
        await loadRules();
        await loadStats();
        return newRule;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('aiRules.createFailed'));
        log.error('Failed to create rule', err);
        throw err;
      }
    },
    [level, loadRules, loadStats, scopedWorkspacePath, t]
  );

  
  const updateRule = useCallback(
    async (name: string, request: UpdateRuleRequest) => {
      try {
        setError(null);
        const updated = await AIRulesAPI.updateRule(level, name, request, scopedWorkspacePath);
        await loadRules();
        await loadStats();
        return updated;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('aiRules.updateFailed'));
        log.error('Failed to update rule', err);
        throw err;
      }
    },
    [level, loadRules, loadStats, scopedWorkspacePath, t]
  );

  
  const deleteRule = useCallback(
    async (name: string) => {
      try {
        setError(null);
        const success = await AIRulesAPI.deleteRule(level, name, scopedWorkspacePath);
        if (success) {
          await loadRules();
          await loadStats();
        }
        return success;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('aiRules.deleteFailed'));
        log.error('Failed to delete rule', err);
        throw err;
      }
    },
    [level, loadRules, loadStats, scopedWorkspacePath, t]
  );

  
  const toggleRule = useCallback(
    async (name: string) => {
      try {
        setError(null);
        const updated = await AIRulesAPI.toggleRule(level, name, scopedWorkspacePath);
        await loadRules();
        await loadStats();
        return updated;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('aiRules.toggleFailed'));
        log.error('Failed to toggle rule', err);
        throw err;
      }
    },
    [level, loadRules, loadStats, scopedWorkspacePath, t]
  );

  
  const refresh = useCallback(async () => {
    
    await AIRulesAPI.reloadRules(level, scopedWorkspacePath);
    
    await loadRules();
    await loadStats();
  }, [level, loadRules, loadStats, scopedWorkspacePath]);

  
  useEffect(() => {
    loadRules();
    loadStats();
  }, [loadRules, loadStats]);

  return {
    rules,
    stats,
    isLoading,
    error,
    createRule,
    updateRule,
    deleteRule,
    toggleRule,
    refresh,
  };
}

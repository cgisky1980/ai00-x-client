import { useMemo } from 'react';

export interface TokenBreakdown {
  systemPrompt: number;
  toolInjection: number;
  rules: number;
  memories: number;
  total: number;
  contextWindowSize: number;
  percentage: string;
}

const CONTEXT_WINDOW_SIZE = 128_000;
const TOKENS_PER_TOOL = 45;
const TOKENS_PER_RULE = 80;
const TOKENS_PER_MEMORY = 60;
const CHARS_PER_TOKEN = 3;

export function estimateTokens(
  body: string,
  enabledToolCount: number,
  rulesCount: number,
  memoriesCount: number,
): TokenBreakdown {
  const systemPrompt = Math.ceil(body.length / CHARS_PER_TOKEN);
  const toolInjection = enabledToolCount * TOKENS_PER_TOOL;
  const rules = rulesCount * TOKENS_PER_RULE;
  const memories = memoriesCount * TOKENS_PER_MEMORY;
  const total = systemPrompt + toolInjection + rules + memories;
  const percentage = ((total / CONTEXT_WINDOW_SIZE) * 100).toFixed(1) + '%';

  return {
    systemPrompt,
    toolInjection,
    rules,
    memories,
    total,
    contextWindowSize: CONTEXT_WINDOW_SIZE,
    percentage,
  };
}

export function useTokenEstimate(
  body: string,
  enabledToolCount: number,
  rulesCount: number,
  memoriesCount: number,
): TokenBreakdown {
  return useMemo(
    () => estimateTokens(body, enabledToolCount, rulesCount, memoriesCount),
    [body, enabledToolCount, rulesCount, memoriesCount],
  );
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

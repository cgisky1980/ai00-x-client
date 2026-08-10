import type { TFunction } from 'i18next';
import type { SubagentSource } from '@/infrastructure/api/service-api/SubagentAPI';
import type { AgentKind, AgentWithCapabilities } from './agentsStore';

interface AgentBadgeConfig {
  variant: 'accent' | 'info' | 'success' | 'purple' | 'neutral';
  label: string;
}

function getAgentBadge(
  t: TFunction<'scenes/agents'>,
  agentKind?: AgentKind,
  source?: SubagentSource,
): AgentBadgeConfig {
  if (agentKind === 'mode') {
    return { variant: 'accent', label: t('agentCard.badges.agent', 'Agent') };
  }

  switch (source) {
    case 'user':
      return { variant: 'success', label: t('agentCard.badges.userSubagent', 'User Sub-Agent') };
    case 'project':
      return { variant: 'purple', label: t('agentCard.badges.projectSubagent', 'Project Sub-Agent') };
    default:
      return { variant: 'info', label: t('agentCard.badges.subagent', 'Sub-Agent') };
  }
}

function enrichCapabilities(agent: AgentWithCapabilities): AgentWithCapabilities {
  if (agent.capabilities?.length) return agent;
  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();

  if (agent.agentKind === 'mode') {
    if (id === 'core') return { ...agent, capabilities: [{ category: 'coding', level: 5 }, { category: 'analysis', level: 4 }] };
    if (id === 'plan') return { ...agent, capabilities: [{ category: 'analysis', level: 5 }, { category: 'docs', level: 3 }] };
    if (id === 'debug') return { ...agent, capabilities: [{ category: 'coding', level: 5 }, { category: 'analysis', level: 3 }] };
    if (id === 'deepresearch') return { ...agent, capabilities: [{ category: 'analysis', level: 5 }, { category: 'docs', level: 4 }] };
  }

  if (id === 'explore') return { ...agent, capabilities: [{ category: 'analysis', level: 4 }, { category: 'coding', level: 3 }] };
  if (id === 'file_finder') return { ...agent, capabilities: [{ category: 'analysis', level: 3 }, { category: 'coding', level: 2 }] };

  if (name.includes('code') || name.includes('debug') || name.includes('test')) {
    return { ...agent, capabilities: [{ category: 'coding', level: 4 }] };
  }
  if (name.includes('doc') || name.includes('write')) {
    return { ...agent, capabilities: [{ category: 'docs', level: 4 }] };
  }

  return { ...agent, capabilities: [{ category: 'analysis', level: 3 }] };
}

export { getAgentBadge, enrichCapabilities };
export type { AgentBadgeConfig };

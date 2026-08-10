export const HIDDEN_AGENT_IDS = new Set<string>([]);

export const TOP_LEVEL_AGENT_IDS = new Set<string>(['Code', 'Task', 'Wallpaper']);

export function isAgentInOverviewZone(agent: { id: string }): boolean {
  return !HIDDEN_AGENT_IDS.has(agent.id) && !TOP_LEVEL_AGENT_IDS.has(agent.id);
}

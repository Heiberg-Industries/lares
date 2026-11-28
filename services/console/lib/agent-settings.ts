import { actingAddress } from './auth';
import { keeper } from './keeper-client';

export interface AgentSettingView {
  key: string;
  section: string;
  label: string;
  description: string;
  value: string | null;
  /** 'default': nothing is saved, so the agents use this value the keeper derives (the console
   * address: the installation's own address). */
  from: 'console' | 'installation file' | 'default' | 'none';
  agentCount: number;
}
export interface AgentSettingsView { settings: AgentSettingView[]; canChange: boolean }

/** One keeper read per page render. Null means it could not be read (no session, keeper down). */
export async function getAgentSettingsView(): Promise<AgentSettingsView | null> {
  const actor = await actingAddress("owner");
  if (!actor) return null;
  try { return await keeper<AgentSettingsView>('settings.agent_environment_get', {}, actor); }
  catch { return null; }
}

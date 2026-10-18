import { useSyncExternalStore } from 'react';
import { getAgentJids, subscribeAgentList } from '@/xmpp/agents';

/** JIDs de los agentes conocidos (snapshot estable). */
export function useAgentJids(): readonly string[] {
  return useSyncExternalStore(subscribeAgentList, getAgentJids);
}

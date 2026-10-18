/**
 * Estado de los agentes OpenClaw (telemetría + hooks PEP): un único store para
 * toda la app, alimentado por pep.ts y leído por la UI vía useAgentState.
 */
import { AgentStateStore, type AgentState } from '@/xmpp/pep/agentState';
import type { ApprovalHook } from '@/xmpp/pep/hooks';

export const agents = new AgentStateStore();

/**
 * AgentStateStore muta su estado in situ, así que no sirve como snapshot de
 * useSyncExternalStore: guardamos una copia superficial por jid que sólo se
 * rehace cuando el store notifica (referencia estable entre cambios).
 */
const snapshots = new Map<string, AgentState>();

let agentJids: readonly string[] = [];
const agentListListeners = new Set<() => void>();

agents.subscribe((jid, state) => {
  const isNew = !snapshots.has(jid);
  snapshots.set(jid, {
    ...state,
    approvals: new Map(state.approvals),
    timeline: [...state.timeline],
  });
  if (isNew) {
    agentJids = Object.freeze([...snapshots.keys()].sort());
    agentListListeners.forEach((cb) => cb());
  }
});

/** JIDs (bare) de los agentes que han publicado telemetría o hooks; snapshot estable. */
export function getAgentJids(): readonly string[] {
  return agentJids;
}

export function subscribeAgentList(cb: () => void): () => void {
  agentListListeners.add(cb);
  return () => { agentListListeners.delete(cb); };
}

export function getAgentSnapshot(jid: string): AgentState | undefined {
  return snapshots.get(jid.split('/')[0] ?? jid);
}

export function subscribeAgent(jid: string, cb: () => void): () => void {
  const bare = jid.split('/')[0] ?? jid;
  return agents.subscribe((changed) => {
    if (changed === bare) cb();
  });
}

/**
 * Hook de aprobación cuyo stanzaId coincide con el del mensaje con botones.
 * Los hooks pueden llegar antes que el mensaje: el store los conserva.
 */
export function approvalForStanza(jid: string, stanzaId: string): ApprovalHook | undefined {
  let found: ApprovalHook | undefined;
  for (const approval of getAgentSnapshot(jid)?.approvals.values() ?? []) {
    if (approval.stanzaId === stanzaId) found = approval;
  }
  return found;
}

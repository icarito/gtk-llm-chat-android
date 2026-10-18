/**
 * Referencias vivas de la sesión (cliente y cuenta). Un único lugar en vez de
 * `let` globales repartidos: los módulos de src/xmpp leen de aquí.
 *
 * TRAMPA: no leas `session.client` después de un `await`. Un reintento lo
 * reemplaza/pone a null al caer la conexión; captura la referencia antes.
 */
import type { Client } from '@xmpp/xml';
import type { XmppAccountConfig } from '@/types/xmpp';
import { Connection } from '@/xmpp/connection';

export const session: {
  client: Client | null;
  account: XmppAccountConfig | null;
} = {
  client: null,
  account: null,
};

export const attemptHook: { fn: () => Promise<void> } = { fn: async () => {} };

/** El `attempt` real lo inyecta XmppService (rompe el ciclo con el ciclo de vida). */
export const connection = new Connection({
  attempt: () => attemptHook.fn(),
  hasAccount: () => session.account !== null,
});


/** Contexto que el router entrega a los handlers: la config y el cliente de ESTA conexión. */
export interface StanzaCtx {
  client: Client;
  config: XmppAccountConfig;
  botNick: string;
}

/** Cliente listo para hablar, o null (equivale al antiguo `!xmppClient || state !== 'online'`). */
export function usableClient(): Client | null {
  return session.client && connection.isUsable() ? session.client : null;
}

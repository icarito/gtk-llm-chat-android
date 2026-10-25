/**
 * Obtención de credenciales TURN/STUN vía XEP-0215 (External Service
 * Discovery). El servidor (Prosody turn_external) expide credenciales con
 * expiración; hay que pedirlas en cada llamada antes de crear la oferta.
 */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { usableClient, session } from '@/xmpp/session';

export const EXTDISCO_NS = 'urn:xmpp:extdisco:1';
const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';
const DISCO_INFO_NS = 'http://jabber.org/protocol/disco#info';

export interface TurnServer {
  urls: string[];
  username?: string;
  credential?: string;
}

function parseServices(root: Element): TurnServer[] {
  const out: TurnServer[] = [];
  for (const service of root.getChildren('service', EXTDISCO_NS)) {
    const type = service.attrs.type as string | undefined;
    const host = service.attrs.host as string | undefined;
    const port = service.attrs.port as string | undefined;
    if (!type || !host) continue;
    const username = service.attrs.username as string | undefined;
    const password = service.attrs.password as string | undefined;
    if (type === 'turn') {
      const urls = [`turn:${host}:${port ?? '3478'}?transport=udp`, `turn:${host}:${port ?? '3478'}?transport=tcp`];
      out.push({ urls, username, credential: password });
    } else if (type === 'stun') {
      out.push({ urls: [`stun:${host}:${port ?? '3478'}`] });
    }
  }
  return out;
}

function accountDomain(): string | undefined {
  const jid = session.account?.jid;
  if (!jid) return undefined;
  const at = jid.indexOf('@');
  return at >= 0 ? jid.slice(at + 1) : jid;
}

async function discoInfoForNode(node: string): Promise<TurnServer[]> {
  const client = usableClient();
  const domain = accountDomain();
  if (!client || !domain) return [];
  try {
    const result = await client.iqCaller.request(
      xml('iq', { type: 'get', to: domain },
        xml('query', { xmlns: DISCO_INFO_NS, node })),
      10000,
    );
    const services = result.getChild('query', DISCO_INFO_NS)?.getChild('services', EXTDISCO_NS);
    if (!services) return [];
    return parseServices(services);
  } catch {
    return [];
  }
}

/** Descubre los servicios externos del servidor (XEP-0215). */
export async function fetchTurnServers(): Promise<TurnServer[]> {
  // 1) Intento directo: disco#info sobre el dominio con el nodo extdisco.
  const direct = await discoInfoForNode(EXTDISCO_NS);
  if (direct.length > 0) return direct;

  // 2) Fallback: disco#items del dominio y pregunta a cada  con el nodo.
  const client = usableClient();
  const domain = accountDomain();
  if (!client || !domain) return [];
  try {
    const items = await client.iqCaller.request(
      xml('iq', { type: 'get', to: domain },
        xml('query', { xmlns: DISCO_ITEMS_NS })),
      10000,
    );
    for (const item of items.getChild('query', DISCO_ITEMS_NS)?.getChildren('item') ?? []) {
      const jid = item.attrs.jid as string | undefined;
      if (!jid || jid === domain) continue;
      const found = await discoInfoForNode(EXTDISCO_NS);
      const viaJid = await (async () => {
        try {
          const r = await client.iqCaller.request(
            xml('iq', { type: 'get', to: jid },
              xml('query', { xmlns: DISCO_INFO_NS, node: EXTDISCO_NS })),
            8000,
          );
          const services = r.getChild('query', DISCO_INFO_NS)?.getChild('services', EXTDISCO_NS);
          return services ? parseServices(services) : [];
        } catch {
          return [];
        }
      })();
      if (viaJid.length > 0) return viaJid;
      if (found.length > 0) return found;
    }
    return [];
  } catch {
    return [];
  }
}

/** RFC 6121: roster y presencia de contactos. */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { XmppContact } from '@/types/xmpp';
import { updateContactNameCache } from '@/xmpp/notifications';
import { updateContactShortcuts } from '@/xmpp/shortcuts';
import { bareJid, parseCaps } from '@/xmpp/parse';
import { trackMucOccupant } from '@/xmpp/muc';
import { sendInitialPresence } from '@/xmpp/disco';
import type { StanzaCtx } from '@/xmpp/session';
import { connection } from '@/xmpp/session';
import { contacts } from '@/xmpp/store';

/** bare JID -> the set of their resources currently announcing availability. */
let onlineResources = new Map<string, Set<string>>();

/** Reset, or a reconnect keeps phantom "online" resources from the old session and the offline->online flip never registers. */
export function resetRoster() {
  onlineResources = new Map();
  contacts.reset();
}

// Efectos colaterales de cada cambio de roster: caché de nombres para
// notificaciones y shortcuts de launcher por contacto (dedupe interno, barato).
contacts.subscribe(() => {
  const arr = contacts.getAll();
  updateContactNameCache(arr);
  void updateContactShortcuts(arr);
});

/**
 * RFC 6121 order: roster FIRST, initial presence only once it lands.
 * Announcing presence makes the server immediately push every contact's
 * presence back at us — if the roster is still empty at that moment,
 * the presence handler drops all of it (it only updates known contacts)
 * and the server never resends, leaving every contact stuck offline.
 */
export function fetchRosterThenAnnounce(ctx: StanzaCtx) {
  connection.step('roster', 'active');
  ctx.client.iqCaller.request(
    xml('iq', { type: 'get' }, xml('query', { xmlns: 'jabber:iq:roster' })),
    15000,
  ).then((result) => {
    const items = result.getChild('query', 'jabber:iq:roster')?.getChildren('item') ?? [];
    const ownBare = bareJid(ctx.config.jid);
    // Rebuild from scratch: the roster query is authoritative, and a stale
    // entry from a previous connection must not survive it.
    contacts.clear();
    for (const item of items) {
      const jid = (item.attrs.jid as string) || '';
      if (!jid || bareJid(jid) === ownBare) continue;
      const sub = (item.attrs.subscription as string) || 'none';
      contacts.set(jid, {
        jid,
        // Sin nombre en el roster lo dejamos vacío a propósito: meter aquí
        // el jid entero hacía que la UI no pudiera distinguir "se llama
        // así" de "no tiene nombre", y acababa pintando el jid crudo en vez
        // de inferir la parte local (ver displayName()).
        name: (item.attrs.name as string) || '',
        subscription: sub as XmppContact['subscription'],
        // Unknown until a <presence> arrives — same as the GTK client.
        presence: 'offline',
        status: undefined,
        caps: undefined,
      });
    }
    contacts.commit();
    connection.step('roster', 'done');
  }).catch(() => {
    connection.step('roster', 'failed');
  }).then(() => {
    // Send it even if the roster query failed: without initial presence the
    // server won't route incoming messages to us at all.
    sendInitialPresence(ctx);
    // No hay sincronización MAM de arranque: se hace por conversación al abrirla.
    connection.step('mam', 'skipped');
    if (connection.state === 'SYNCING') connection.set('ONLINE');
  });
}

export function handlePresence(stanza: Element, ctx: StanzaCtx) {
  const ptype = stanza.attrs.type;
  const from = stanza.attrs.from as string | undefined;
  if (!from) return;
  const bare = bareJid(from);

  // MUC Occupant Real JID tracking for OMEMO group chats
  trackMucOccupant(stanza, bare, ptype);

  if (ptype === 'subscribe') {
    ctx.client.send(xml('presence', { to: bare, type: 'subscribed' }));
    ctx.client.send(xml('presence', { to: bare, type: 'subscribe' }));
    return;
  }
  if (ptype === 'unsubscribe') {
    ctx.client.send(xml('presence', { to: bare, type: 'unsubscribed' }));
    return;
  }
  // Only available/unavailable say anything about presence. Anything else
  // (subscribed, error, …) must not be read as a status change.
  if (ptype !== undefined && ptype !== 'unavailable') return;

  // The roster is whatever the RFC 6121 query returned — presence only
  // UPDATES those entries, it never creates new ones. Otherwise our own
  // account (a second client on another resource, e.g. the GTK app)
  // sends us presence and ends up listed as one of our own contacts.
  const existing = contacts.get(bare);
  if (!existing) return;

  // A contact is online if ANY of their resources is. Tracking them
  // individually matters when they're logged in from two clients: one
  // going away must not mark the whole contact offline.
  const resource = from.split('/')[1] ?? '';
  const resources = onlineResources.get(bare) ?? new Set<string>();
  if (ptype === 'unavailable') {
    resources.delete(resource);
  } else {
    resources.add(resource);
  }
  onlineResources.set(bare, resources);

  const status = stanza.getChildText('status') || undefined;
  const caps = parseCaps(stanza);

  contacts.set(bare, {
    ...existing,
    // Available presence carries no `type` at all; <show> only refines it
    // (away/dnd), so its absence means online — not unknown.
    presence: resources.size > 0 ? 'online' : 'offline',
    status: status ?? existing.status,
    caps: caps || existing.caps,
  });
  contacts.commit();
}

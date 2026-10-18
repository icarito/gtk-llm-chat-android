import 'react-native-get-random-values';
import { readFileSync } from 'fs';
import { join } from 'path';
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { parse } from 'ltx';
import { MemoryStore, SessionManager, buildEnvelope, parseEnvelope } from '@/omemo2';
import { decryptStanzaIfEncrypted } from '@/xmpp/decrypt';
import {
  NODE_BUNDLES,
  NODE_DEVICES,
  Omemo2Engine,
  OMEMO2_FALLBACK_BODY,
  setOmemo2ForTest,
  type IdentityChange,
} from '@/xmpp/omemo2';
import { routeStanza } from '@/xmpp/router';
import { messages, rooms } from '@/xmpp/store';
import { resetRoomOmemo } from '@/xmpp/muc';
import { sendMessage } from '@/xmpp/messages';
import { resetInbound } from '@/xmpp/inbound';
import type { StanzaCtx } from '@/xmpp/session';

let mockClient: unknown = null;
jest.mock('@/xmpp/session', () => ({
  ...jest.requireActual('@/xmpp/session'),
  usableClient: () => mockClient,
}));
jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-secure-store', () => ({}));
jest.mock('@/xmpp/xep-0384', () => ({ Omemo: { isEnabled: () => false } }));
jest.mock('@/xmpp/notifications', () => ({
  isNotificationGraceActive: () => true,
  notifyXmppMessage: jest.fn(),
}));
jest.mock('@/xmpp/XmppHistory', () => ({
  XmppHistory: {
    hasMessage: jest.fn().mockResolvedValue(false),
    isFreshInstall: jest.fn().mockResolvedValue(false),
    recordMessage: jest.fn().mockResolvedValue(undefined),
  },
}));

const ALICE = 'alice@x.org';
const BOB = 'bob@x.org';
const PUBSUB = 'http://jabber.org/protocol/pubsub';

/** PEP en memoria compartido por los motores; todo pasa por texto XML (ida y vuelta del cable). */
class FakePep {
  items = new Map<string, Map<string, Element>>();
  published: string[] = [];
  deps(jid: string) {
    const sent: Element[] = [];
    return {
      sent,
      deps: {
        jid: `${jid}/phone`,
        store: new MemoryStore(),
        send: async (s: Element) => { sent.push(parse(s.toString())); },
        request: async (iq: Element) => {
          const pubsub = parse(iq.toString()).getChild('pubsub')!;
          const publish = pubsub.getChild('publish');
          if (publish) {
            const node = publish.attrs.node;
            const item = publish.getChild('item')!;
            const k = `${jid}|${node}`;
            // Prosody con max_items=max conserva los items por id.
            this.items.set(k, (this.items.get(k) ?? new Map()).set(item.attrs.id, item));
            this.published.push(`${jid}|${node}|${item.attrs.id}`);
            return xml('iq', { type: 'result' });
          }
          const items = pubsub.getChild('items')!;
          const stored = this.items.get(`${(iq.attrs.to as string)}|${items.attrs.node}`);
          if (!stored) throw Object.assign(new Error('item-not-found'), { condition: 'item-not-found' });
          const ids = items.getChildren('item').map((i) => i.attrs.id);
          const hit = [...stored].filter(([id]) => !ids.length || ids.includes(id)).map(([, v]) => v);
          return xml('iq', { type: 'result' }, xml('pubsub', { xmlns: PUBSUB }, xml('items', { node: items.attrs.node }, ...hit)));
        },
      },
    };
  }
}

async function party(pep: FakePep, jid: string, store?: MemoryStore) {
  const p = pep.deps(jid);
  if (store) p.deps.store = store;
  const engine = await Omemo2Engine.create(p.deps);
  await engine.publishOwn();
  return { engine, sent: p.sent, store: p.deps.store };
}

/** Lo que el servidor entrega al destinatario: la stanza serializada y reparseada. */
function wire(from: string, to: string, id: string, children: Element[]): Element {
  return parse(xml('message', { type: 'chat', from: `${from}/phone`, to, id }, ...children).toString());
}

const ctx = (jid: string) => ({ client: { send: jest.fn() }, config: { jid: `${jid}/phone` }, botNick: 'bot' }) as unknown as StanzaCtx;

beforeEach(() => {
  messages.reset();
  resetInbound();
  setOmemo2ForTest(null);
  rooms.reset();
  resetRoomOmemo();
  mockClient = null;
});

describe('OMEMO 2 sobre stanzas', () => {
  test('Alice -> Bob por el router (kex) y respuesta Bob -> Alice', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    expect(pep.published).toEqual(expect.arrayContaining([
      `${ALICE}|${NODE_BUNDLES}|${alice.engine.deviceId}`,
      `${ALICE}|${NODE_DEVICES}|current`,
    ]));

    const children = (await alice.engine.encryptOutgoing(BOB, 'm1', 'hola bob'))!;
    const names = children.map((c) => c.name);
    expect(names).toEqual(['encrypted', 'encryption', 'body', 'store']);
    expect(children[2].text()).toBe(OMEMO2_FALLBACK_BODY);
    const stanza = wire(ALICE, BOB, 'm1', children);
    expect(stanza.toString()).not.toContain('hola bob');
    expect(stanza.getChild('encrypted', 'urn:xmpp:omemo:2')!.getChild('header')!.getChild('keys')!.getChild('key')!.attrs.kex).toBe('true');

    setOmemo2ForTest(bob.engine);
    await routeStanza(stanza, ctx(BOB));
    const got = messages.getConversation(ALICE);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ body: 'hola bob', encryptionStatus: 'omemo2', wasEncrypted: true });

    // Respuesta: sesión ya establecida, sin kex.
    const reply = (await bob.engine.encryptOutgoing(ALICE, 'm2', 'hola alice'))!;
    const r = await alice.engine.decrypt(wire(BOB, ALICE, 'm2', reply), BOB);
    expect(r).toEqual({ body: 'hola alice', status: 'omemo2' });
    expect(wire(BOB, ALICE, 'm2', reply).toString()).not.toContain('kex=');
  });

  test('MAM: el mismo mensaje ya consumido en vivo se recupera del respaldo; la copia saliente propia también', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const stanza = wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'archivado'))!);
    setOmemo2ForTest(bob.engine);
    expect((await decryptStanzaIfEncrypted(stanza, `${ALICE}/phone`)).decryptedBody).toBe('archivado');
    const again = await decryptStanzaIfEncrypted(stanza, ALICE, false);
    expect(again).toMatchObject({ decryptedBody: 'archivado', encryptionStatus: 'omemo2' });
    // Alice (que no puede descifrar su propio envío) lo ve desde el respaldo de salida.
    setOmemo2ForTest(alice.engine);
    expect((await decryptStanzaIfEncrypted(stanza, ALICE, false)).decryptedBody).toBe('archivado');
  });

  test('otro dispositivo propio recibe la copia y la descifra (carbon saliente)', async () => {
    const pep = new FakePep();
    const p2 = pep.deps(ALICE);
    p2.deps.jid = `${ALICE}/tablet`;
    const tablet = await Omemo2Engine.create(p2.deps);
    await tablet.publishOwn();
    const phone = await party(pep, ALICE); // publica y ve la tablet
    const bob = await party(pep, BOB);
    expect(phone.engine.devices(ALICE).map((d) => d.rid).sort()).toEqual([phone.engine.deviceId, tablet.deviceId].sort());
    await tablet.fetchDevices(ALICE);
    const stanza = wire(ALICE, BOB, 'm9', (await phone.engine.encryptOutgoing(BOB, 'm9', 'desde el móvil'))!);
    expect((await tablet.decrypt(stanza, ALICE)).body).toBe('desde el móvil');
    expect((await bob.engine.decrypt(stanza, ALICE)).body).toBe('desde el móvil');
  });

  test('SCE: el from del envelope debe coincidir con el remitente de la stanza', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const stanza = wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'suplantado'))!);
    const r = await bob.engine.decrypt(stanza, 'mallory@x.org/evil');
    expect(r.status).toBe('undecryptable');
    expect(r.body).toContain('remitente no coincide');
    expect(r.body).not.toContain('suplantado');
  });

  test('cambio de identidad: undecryptable + evento, sin tocar la confianza', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const changes: IdentityChange[] = [];
    bob.engine.onIdentityChanged((c) => changes.push(c));
    const stanza = wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'hola'))!);
    // Bob ya conocía a ese dispositivo con otra identidad.
    const old = 'ab'.repeat(32);
    await bob.engine.setTrust(ALICE, alice.engine.deviceId, 'blind', old);
    const r = await bob.engine.decrypt(stanza, ALICE);
    expect(r.status).toBe('undecryptable');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ jid: ALICE, rid: alice.engine.deviceId, oldIdentity: old });
    expect(changes[0].newIdentity).toHaveLength(64);
    expect(bob.engine.devices(ALICE)[0]?.identity ?? old).toBe(old);
    // El usuario revisa y acepta la identidad nueva: el mismo mensaje ya descifra.
    await bob.engine.setTrust(ALICE, alice.engine.deviceId, 'verified', changes[0].newIdentity!);
    expect((await bob.engine.decrypt(stanza, ALICE)).body).toBe('hola');
  });

  test('BTBV: tras verificar un dispositivo, uno nuevo nace sin confianza y no se le cifra', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    await alice.engine.encryptOutgoing(BOB, 'm0', 'x'); // crea sesión y registra a Bob como 'blind'
    await alice.engine.setTrust(BOB, bob.engine.deviceId, 'verified');
    const bob2 = pep.deps(BOB);
    bob2.deps.jid = `${BOB}/tablet`;
    const e2 = await Omemo2Engine.create(bob2.deps);
    await e2.publishOwn();
    await alice.engine.fetchDevices(BOB);
    const stanza = wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'solo al verificado'))!);
    const rids = stanza.getChild('encrypted')!.getChild('header')!.getChildren('keys').flatMap((k) => k.getChildren('key')).map((k) => Number(k.attrs.rid));
    expect(rids).toContain(bob.engine.deviceId);
    expect(rids).not.toContain(e2.deviceId);
    expect(alice.engine.devices(BOB).find((d) => d.rid === e2.deviceId)?.trusted).toBe('distrusted');
  });

  test('prekeys: bajo el umbral se reponen y el bundle se republica', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const store = new MemoryStore();
    await SessionManager.load(store, 25); // Bob nace con 25: el primer kex lo deja en 24 (< 25)
    const bob = await party(pep, BOB, store);
    const bundleKey = `${BOB}|${NODE_BUNDLES}|${bob.engine.deviceId}`;
    const before = pep.published.filter((p) => p === bundleKey).length;
    expect(pep.items.get(`${BOB}|${NODE_BUNDLES}`)!.get(String(bob.engine.deviceId))!.getChild('bundle')!.getChild('prekeys')!.getChildren('pk')).toHaveLength(25);
    const stanza = wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'kex'))!);
    expect((await bob.engine.decrypt(stanza, ALICE)).body).toBe('kex');
    expect(pep.published.filter((p) => p === bundleKey).length).toBe(before + 1);
    expect(pep.items.get(`${BOB}|${NODE_BUNDLES}`)!.get(String(bob.engine.deviceId))!.getChild('bundle')!.getChild('prekeys')!.getChildren('pk')).toHaveLength(100);
  });

  test('key transport tras 53 mensajes recibidos sin contestar', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    for (let i = 0; i < 53; i++) {
      const s = wire(ALICE, BOB, `m${i}`, (await alice.engine.encryptOutgoing(BOB, `m${i}`, `n${i}`))!);
      expect((await bob.engine.decrypt(s, ALICE)).body).toBe(`n${i}`);
      expect(bob.sent).toHaveLength(i < 52 ? 0 : 1);
    }
    const kt = bob.sent[0];
    expect(kt.attrs.to).toBe(ALICE);
    expect(kt.getChild('encrypted')!.getChild('payload')).toBeUndefined();
    // Alice lo procesa sin mostrar nada.
    expect(await alice.engine.decrypt(kt.attrs.from ? kt : wire(BOB, ALICE, 'kt', kt.children as Element[]), BOB))
      .toEqual({ body: '', status: 'omemo2' });
  });

  test('sin dispositivos OMEMO 2 del contacto o con el cifrado desactivado: null (el llamador cae a legacy/plano)', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    expect(await alice.engine.encryptOutgoing('nadie@x.org', 'm', 'x')).toBeNull();
    const bob = await party(pep, BOB);
    await alice.engine.setEnabledFor(BOB, false);
    expect(alice.engine.isEnabledFor(BOB)).toBe(false);
    expect(await alice.engine.encryptOutgoing(BOB, 'm', 'x')).toBeNull();
    expect(bob.engine.isEnabledFor(ALICE)).toBe(true);
  });
});

const ROOM = 'sala@muc.x.org';
const CAROL = 'carol@x.org';
const DAVE = 'dave@x.org'; // sin OMEMO 2

/** Sala unida desde la perspectiva de `ownNick`; `occ` = nick -> JID real. */
function setRoom(ownNick: string, occ: Record<string, string>) {
  rooms.patch(ROOM, {
    nick: ownNick, state: 'joined',
    occupants: Object.fromEntries(Object.entries(occ).map(([nick, jid]) => [nick, { nick, realJid: `${jid}/phone`, role: 'participant', affiliation: 'member', isAgent: false }])),
  }, {});
}

/** Cliente falso: disco#info de la sala, listas de afiliación y envíos capturados. */
function roomClient(nonAnonymous: boolean, members: string[] = []) {
  const sent: Element[] = [];
  mockClient = {
    send: async (s: Element) => { sent.push(parse(s.toString())); },
    iqCaller: {
      request: async (iq: Element) => {
        const query = iq.getChild('query')!;
        if (query.attrs.xmlns === 'http://jabber.org/protocol/disco#info') {
          return xml('iq', { type: 'result' }, xml('query', { xmlns: query.attrs.xmlns },
            ...(nonAnonymous ? [xml('feature', { var: 'muc_nonanonymous' })] : [xml('feature', { var: 'muc_semianonymous' })]),
            xml('feature', { var: 'muc_membersonly' })));
        }
        const aff = query.getChild('item')!.attrs.affiliation;
        if (aff === 'owner') throw Object.assign(new Error('forbidden'), { condition: 'forbidden' });
        return xml('iq', { type: 'result' }, xml('query', { xmlns: query.attrs.xmlns },
          ...(aff === 'member' ? members.map((jid) => xml('item', { jid, affiliation: 'member' })) : [])));
      },
    },
  };
  return sent;
}

/** La stanza de sala que el servidor reparte a los demás (from = sala/nick). */
const roomWire = (sent: Element, nick: string, to: string, extra: Element[] = []): Element => {
  const s = parse(sent.toString());
  s.attrs.from = `${ROOM}/${nick}`;
  s.attrs.to = `${to}/phone`;
  s.children.push(...extra);
  return parse(s.toString());
};

describe('OMEMO 2 en salas MUC', () => {
  test('ida y vuelta Alice -> Bob y Carol en sala no anónima; el eco propio no duplica y un sin-OMEMO se reporta', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const carol = await party(pep, CAROL);
    const sent = roomClient(true, [CAROL, DAVE]);
    setOmemo2ForTest(alice.engine);
    setRoom('alice', { alice: ALICE, bob: BOB });
    const id = await sendMessage(ROOM, 'hola sala', 'groupchat');

    expect(sent).toHaveLength(1);
    const out = sent[0];
    expect(out.toString()).not.toContain('hola sala');
    const keyed = out.getChild('encrypted')!.getChild('header')!.getChildren('keys').map((k) => k.attrs.jid).sort();
    expect(keyed).toEqual([BOB, CAROL]); // Dave sin dispositivos; Alice sin otros dispositivos
    expect(rooms.get(ROOM)).toMatchObject({ nonAnonymous: true, membersOnly: true, omemoSkipped: 1 });
    expect(messages.getConversation(ROOM)[0]).toMatchObject({ body: 'hola sala', encryptionStatus: 'omemo2', sendState: 'sent' });

    // Bob y Carol descifran la MISMA stanza (el eco al remitente real sale del mapa de ocupantes).
    for (const [who, nick] of [[bob, 'bob'], [carol, 'carol']] as const) {
      messages.reset(); resetInbound();
      setOmemo2ForTest(who.engine);
      setRoom(nick, { alice: ALICE, bob: BOB, carol: CAROL });
      await routeStanza(roomWire(out, 'alice', who === bob ? BOB : CAROL), ctx(who === bob ? BOB : CAROL));
      expect(messages.getConversation(ROOM)).toHaveLength(1);
      expect(messages.getConversation(ROOM)[0]).toMatchObject({ body: 'hola sala', encryptionStatus: 'omemo2', senderNick: 'alice' });
    }

    // Eco de la sala a Alice: se muestra descifrado desde el respaldo y no crea otra burbuja.
    messages.reset(); resetInbound();
    setOmemo2ForTest(alice.engine);
    setRoom('alice', { alice: ALICE, bob: BOB });
    const echo = roomWire(out, 'alice', ALICE);
    expect((await decryptStanzaIfEncrypted(echo, `${ROOM}/alice`)).decryptedBody).toBe('hola sala');
    await routeStanza(echo, ctx(ALICE));
    expect(messages.getConversation(ROOM)).toHaveLength(0);
    expect(id).toBe(out.attrs.id);
  });

  test('sala anónima: texto plano, sin lanzar, con motivo visible', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    await party(pep, BOB);
    const sent = roomClient(false);
    setOmemo2ForTest(alice.engine);
    setRoom('alice', { alice: ALICE, bob: BOB });
    await expect(sendMessage(ROOM, 'a la vista', 'groupchat')).resolves.toBeTruthy();
    expect(sent[0].getChildText('body')).toBe('a la vista');
    expect(sent[0].getChild('encrypted')).toBeUndefined();
    expect(rooms.get(ROOM)).toMatchObject({ nonAnonymous: false, omemoUnavailableReason: 'sala anónima' });
  });

  test('remitente no resoluble: marcador honesto; en MAM se usa muc#user; from distinto se rechaza', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const carol = await party(pep, CAROL);
    const sent = roomClient(true, [CAROL]);
    setOmemo2ForTest(alice.engine);
    setRoom('alice', { alice: ALICE, bob: BOB });
    await sendMessage(ROOM, 'quién soy', 'groupchat');
    const out = sent[0];

    setOmemo2ForTest(bob.engine);
    setRoom('bob', { bob: BOB }); // Bob no conoce al ocupante `alice`
    const r = await decryptStanzaIfEncrypted(roomWire(out, 'alice', BOB), `${ROOM}/alice`);
    expect(r).toMatchObject({ decryptedBody: '🔒 [OMEMO 2: remitente desconocido en la sala]', encryptionStatus: 'undecryptable' });

    const item = xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, xml('item', { jid: `${ALICE}/phone`, affiliation: 'member' }));
    const mam = await decryptStanzaIfEncrypted(roomWire(out, 'alice', BOB, [item]), `${ROOM}/alice`, false);
    expect(mam).toMatchObject({ decryptedBody: 'quién soy', encryptionStatus: 'omemo2' });

    // Envelope con to=sala aceptado arriba; un remitente real distinto del `from` firmado se rechaza.
    const wrong = await carol.engine.decrypt(roomWire(out, 'alice', CAROL), 'mallory@x.org', true, ROOM);
    expect(wrong.body).toContain('remitente no coincide');
  });

  test('encryptOutgoingGroup: null sin destinatarios con OMEMO 2; lanza si tienen dispositivos pero ninguno sirve', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    expect(await alice.engine.encryptOutgoingGroup(ROOM, [DAVE], 'g0', 'x')).toBeNull();
    const bob = await party(pep, BOB);
    await alice.engine.encryptOutgoingGroup(ROOM, [BOB], 'g1', 'x');
    await alice.engine.setTrust(BOB, bob.engine.deviceId, 'distrusted');
    await expect(alice.engine.encryptOutgoingGroup(ROOM, [BOB], 'g2', 'x')).rejects.toThrow('sin dispositivos utilizables');
  });
});

describe('SCE <to> y confianza en muc#user', () => {
  const envTo: { v: string | undefined } = { v: undefined };
  const rewriteEnvelope = (e: Omemo2Engine) => {
    const sm = (e as unknown as { sm: { encryptForDevices: (d: unknown, env: Uint8Array) => Promise<unknown> } }).sm;
    const orig = sm.encryptForDevices.bind(sm);
    sm.encryptForDevices = (d, env) => orig(d, buildEnvelope(parseEnvelope(env).body!, { from: ALICE, ...(envTo.v ? { to: envTo.v } : {}) }));
  };
  const inbound = (stanza: Element) => decryptStanzaIfEncrypted(stanza, `${stanza.attrs.from}`);

  test('un ciphertext 1:1 reinyectado como groupchat, o de la sala A entregado como sala B, se rechaza', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const carol = await party(pep, CAROL);
    setOmemo2ForTest(bob.engine);
    setRoom('bob', { alice: ALICE, bob: BOB });
    const oneToOne = wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'privado'))!);
    oneToOne.attrs.type = 'groupchat';
    oneToOne.attrs.from = `${ROOM}/alice`;
    const r = await inbound(oneToOne);
    expect(r).toMatchObject({ encryptionStatus: 'undecryptable' });
    expect(r.decryptedBody).toContain('destinatario no coincide');

    const sent = roomClient(true);
    setOmemo2ForTest(alice.engine);
    setRoom('alice', { alice: ALICE, carol: CAROL });
    await sendMessage(ROOM, 'solo sala A', 'groupchat');
    setOmemo2ForTest(carol.engine);
    rooms.patch('otra@muc.x.org', { nick: 'carol', state: 'joined', occupants: { alice: { nick: 'alice', realJid: `${ALICE}/phone`, role: 'participant', affiliation: 'member', isAgent: false } } }, {});
    const other = roomWire(sent[0], 'alice', CAROL);
    other.attrs.from = 'otra@muc.x.org/alice';
    const r2 = await inbound(other);
    expect(r2.decryptedBody).toContain('destinatario no coincide');
  });

  test('1:1 sin <to> se acepta; con <to> ajeno se rechaza', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    setOmemo2ForTest(bob.engine);
    rewriteEnvelope(alice.engine);
    const ok = await inbound(wire(ALICE, BOB, 'm1', (await alice.engine.encryptOutgoing(BOB, 'm1', 'sin to'))!));
    expect(ok.decryptedBody).toBe('sin to');
    envTo.v = 'otro@x.org';
    const bad = await inbound(wire(ALICE, BOB, 'm2', (await alice.engine.encryptOutgoing(BOB, 'm2', 'to ajeno'))!));
    expect(bad.decryptedBody).toContain('destinatario no coincide');
  });

  test('muc#user forjado: en vivo gana el mapa de ocupantes; sin sala unida o ocupante, nada', async () => {
    const pep = new FakePep();
    const alice = await party(pep, ALICE);
    const bob = await party(pep, BOB);
    const sent = roomClient(true);
    setOmemo2ForTest(alice.engine);
    setRoom('alice', { alice: ALICE, bob: BOB });
    await sendMessage(ROOM, 'x', 'groupchat');
    const forged = xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, xml('item', { jid: `${ALICE}/phone` }));

    setOmemo2ForTest(bob.engine);
    setRoom('bob', { bob: BOB });
    const stranger = roomWire(sent[0], 'evil', BOB, [forged]);
    expect((await inbound(stranger)).decryptedBody).toContain('remitente desconocido');
    // Mapa dice mallory: manda el mapa, no el item forjado.
    setRoom('bob', { bob: BOB, evil: 'mallory@x.org' });
    expect((await inbound(stranger)).decryptedBody).toContain('remitente no coincide');
    // Sala no unida: sin resolución aunque el item exista.
    rooms.patch(ROOM, { state: 'left' });
    expect((await decryptStanzaIfEncrypted(stranger, `${ROOM}/evil`, false)).decryptedBody).toContain('remitente desconocido');
  });
});

describe('polyfill de aleatoriedad', () => {
  test('crypto.getRandomValues existe en el entorno de test', () => {
    expect(typeof globalThis.crypto.getRandomValues).toBe('function');
  });

  test('el entry de la app importa react-native-get-random-values antes que nada', () => {
    const src = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
    const first = src.split('\n').find((l) => l.startsWith('import'));
    expect(first).toBe("import 'react-native-get-random-values';");
    expect(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).main).toBe('./index.js');
    const layout = readFileSync(join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
    expect(layout.startsWith("import 'react-native-get-random-values'")).toBe(true);
  });
});

test('publish-options que no coinciden con el nodo: reintenta sin opciones', async () => {
  const pep = new FakePep();
  const p = pep.deps(ALICE);
  const inner = p.deps.request;
  const seen: (string | null)[] = [];
  p.deps.request = async (iq: Element) => {
    const pubsub = parse(iq.toString()).getChild('pubsub')!;
    if (pubsub.getChild('publish')) {
      const max = pubsub.getChild('publish-options')?.getChild('x')?.getChildren('field')
        .find((f) => f.attrs.var === 'pubsub#max_items')?.getChildText('value') ?? null;
      seen.push(max);
      // Nodo creado por otro cliente con max_items=10: Prosody rechaza cualquier otro valor.
      if (max !== null) throw Object.assign(new Error('conflict'), { application: { name: 'precondition-not-met' } });
    }
    return inner(iq);
  };
  const engine = await Omemo2Engine.create(p.deps);
  await engine.publishOwn();
  expect(seen).toEqual(['100', null, '1', null]);
  expect(pep.published).toEqual([
    `${ALICE}|${NODE_BUNDLES}|${engine.deviceId}`,
    `${ALICE}|${NODE_DEVICES}|current`,
  ]);
});

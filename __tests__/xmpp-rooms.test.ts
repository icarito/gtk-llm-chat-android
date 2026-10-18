/**
 * Integración MUC + reacciones/respuestas/retractación con stanzas falsas,
 * entrando por el router igual que en producción.
 */
import { parse } from 'ltx';
import { routeStanza } from '@/xmpp/router';
import { connection, session, type StanzaCtx } from '@/xmpp/session';
import { contacts, invites, messages, rooms } from '@/xmpp/store';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { acceptInvite, declineInvite, joinRoom, startRooms } from '@/xmpp/rooms';
import { react, retractMessage } from '@/xmpp/annotations';
import { sendMessage } from '@/xmpp/messages';
import { resetInbound } from '@/xmpp/inbound';
import { parseMamResult } from '@/xmpp/mam';
import type { XmppMessage } from '@/types/xmpp';

jest.mock('@/xmpp/XmppHistory', () => ({
  XmppHistory: {
    hasMessage: jest.fn().mockResolvedValue(false),
    // Instalación nueva: el mensaje entra al store sin disparar notificaciones.
    isFreshInstall: jest.fn().mockResolvedValue(true),
    recordMessage: jest.fn().mockResolvedValue(true),
    setMucStanzaId: jest.fn().mockResolvedValue(undefined),
    updateReactions: jest.fn().mockResolvedValue(true),
    markRetracted: jest.fn().mockResolvedValue(true),
  },
}));

const ROOM = 'sala@conference.example.org';
const ME = 'yo@example.org';

const send = jest.fn().mockResolvedValue(undefined);
const request = jest.fn();
const ctx = {
  client: { send, iqCaller: { request } },
  config: { jid: ME, password: '', service: '', resource: 'r' },
  botNick: 'yo',
} as unknown as StanzaCtx;

function feed(xmlText: string) {
  return routeStanza(parse(xmlText.replace('<message ', '<message xmlns="jabber:client" ')
    .replace('<presence', '<presence xmlns="jabber:client"')), ctx);
}

function mucPresence(nick: string, opts: { jid?: string; type?: string; codes?: number[]; role?: string; aff?: string } = {}) {
  const status = (opts.codes ?? []).map((c) => `<status code="${c}"/>`).join('');
  return `<presence from="${ROOM}/${nick}" ${opts.type ? `type="${opts.type}"` : ''}>
    <x xmlns="http://jabber.org/protocol/muc#user">
      <item affiliation="${opts.aff ?? 'member'}" role="${opts.role ?? 'participant'}" ${opts.jid ? `jid="${opts.jid}"` : ''}/>${status}
    </x></presence>`;
}

function groupMsg(over: Partial<XmppMessage> = {}): XmppMessage {
  return {
    id: 'm1', from: ROOM, to: ME, type: 'groupchat', body: 'hola', timestamp: '2026-01-01T00:00:00.000Z',
    direction: 'in', isGroup: true, stanzaId: 'sid-1', senderNick: 'ana', ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  rooms.reset();
  invites.reset();
  contacts.reset();
  resetInbound();
  messages.reset();
  session.client = ctx.client;
  session.account = ctx.config;
  connection.set('ONLINE');
});

describe('join y presencia de sala', () => {
  it('envía la presencia de entrada con history 0 y pasa a joined con la presencia propia (110)', async () => {
    await joinRoom(ROOM, 'yo');
    expect(rooms.get(ROOM)?.state).toBe('joining');
    const sent = send.mock.calls[0]![0];
    expect(sent.attrs.to).toBe(`${ROOM}/yo`);
    expect(sent.getChild('x').getChild('history').attrs.maxstanzas).toBe('0');

    await feed(mucPresence('ana', { jid: 'ana@example.org/x', role: 'moderator', aff: 'admin' }));
    await feed(mucPresence('yo', { codes: [110], aff: 'owner', role: 'moderator' }));
    await feed(`<message from="${ROOM}/ana" type="groupchat"><subject>Tema</subject></message>`);

    const room = rooms.get(ROOM)!;
    expect(room.state).toBe('joined');
    expect(room.affiliation).toBe('owner');
    expect(room.subject).toBe('Tema');
    expect(room.occupants.ana).toMatchObject({ realJid: 'ana@example.org/x', role: 'moderator', isAgent: false });
  });

  it('marca kicked / banned y vacía los ocupantes; un ocupante que se va desaparece', async () => {
    await joinRoom(ROOM, 'yo');
    await feed(mucPresence('ana'));
    await feed(mucPresence('ana', { type: 'unavailable' }));
    expect(rooms.get(ROOM)!.occupants.ana).toBeUndefined();

    await feed(mucPresence('yo', { type: 'unavailable', codes: [110, 307] }));
    expect(rooms.get(ROOM)!.state).toBe('kicked');
    await feed(mucPresence('yo', { type: 'unavailable', codes: [110, 301] }));
    expect(rooms.get(ROOM)!.state).toBe('banned');
  });

  it('renombra al ocupante en un cambio de nick (303)', async () => {
    await joinRoom(ROOM, 'yo');
    await feed(mucPresence('ana'));
    await feed(`<presence from="${ROOM}/ana" type="unavailable"><x xmlns="http://jabber.org/protocol/muc#user">
      <item affiliation="member" role="participant" nick="ana2"/><status code="303"/></x></presence>`);
    expect(Object.keys(rooms.get(ROOM)!.occupants)).toEqual(['ana2']);
  });

  it('marca agente por la identidad automation de sus caps', async () => {
    request.mockResolvedValueOnce(parse(
      '<iq type="result" xmlns="jabber:client"><query xmlns="http://jabber.org/protocol/disco#info"><identity category="automation" type="command-list"/></query></iq>',
    ));
    await joinRoom(ROOM, 'yo');
    await feed(`<presence from="${ROOM}/bot"><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant"/></x>
      <c xmlns="http://jabber.org/protocol/caps" node="urn:bot" ver="1"/></presence>`);
    await new Promise((r) => setImmediate(r));
    expect(rooms.get(ROOM)!.occupants.bot!.isAgent).toBe(true);
  });

  it('la presencia de sala no toca a los contactos; la de un contacto sí', async () => {
    contacts.set(ROOM, { jid: ROOM, name: '', subscription: 'both', presence: 'offline' });
    contacts.set('ana@example.org', { jid: 'ana@example.org', name: '', subscription: 'both', presence: 'offline' });
    await feed(mucPresence('ana', { jid: 'ana@example.org/x' }));
    expect(contacts.get(ROOM)!.presence).toBe('offline');
    expect(contacts.get('ana@example.org')!.presence).toBe('offline');

    await feed('<presence from="ana@example.org/phone"/>');
    expect(contacts.get('ana@example.org')!.presence).toBe('online');
  });
});

describe('marcadores', () => {
  it('trae los marcadores y entra sólo a los de autojoin', async () => {
    request.mockResolvedValueOnce(parse(`<iq type="result" xmlns="jabber:client"><pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="urn:xmpp:bookmarks:1">
      <item id="a@c.x"><conference xmlns="urn:xmpp:bookmarks:1" name="A" autojoin="true"><nick>apodo</nick></conference></item>
      <item id="b@c.x"><conference xmlns="urn:xmpp:bookmarks:1" name="B" autojoin="false"/></item>
    </items></pubsub></iq>`));
    await startRooms(ctx);
    await new Promise((r) => setImmediate(r));
    expect(rooms.get('a@c.x')).toMatchObject({ bookmarked: true, name: 'A', state: 'joining', nick: 'apodo' });
    expect(rooms.get('b@c.x')).toMatchObject({ bookmarked: true, state: 'left' });
    expect(send.mock.calls.map((c) => c[0].attrs.to)).toEqual(['a@c.x/apodo']);
  });

  it('vuelve a entrar a las salas en que estábamos tras una sesión nueva', async () => {
    await joinRoom(ROOM, 'yo');
    await feed(mucPresence('yo', { codes: [110] }));
    send.mockClear();
    request.mockRejectedValueOnce(new Error('item-not-found'));
    await startRooms(ctx);
    expect(send.mock.calls.map((c) => c[0].attrs.to)).toEqual([`${ROOM}/yo`]);
  });

  it('un evento PEP de marcadores hace autojoin; ajenos se ignoran', async () => {
    const event = (from: string) => `<message from="${from}"><event xmlns="http://jabber.org/protocol/pubsub#event"><items node="urn:xmpp:bookmarks:1">
      <item id="n@c.x"><conference xmlns="urn:xmpp:bookmarks:1" autojoin="true"/></item></items></event></message>`;
    await feed(event('intruso@example.org'));
    expect(rooms.get('n@c.x')).toBeUndefined();
    await feed(event(ME));
    expect(rooms.get('n@c.x')!.state).toBe('joining');
  });
});

describe('invitaciones', () => {
  const mediated = `<message from="${ROOM}"><x xmlns="http://jabber.org/protocol/muc#user">
    <invite from="ana@example.org/x"><reason>ven</reason></invite></x></message>`;

  it('lista la invitación humanizada y al aceptar entra a la sala', async () => {
    contacts.set('ana@example.org', { jid: 'ana@example.org', name: 'Ana Pérez', subscription: 'both', presence: 'offline' });
    await feed(mediated);
    expect(invites.getAll()).toHaveLength(1);
    expect(invites.getAll()[0]).toMatchObject({ room: ROOM, roomName: 'sala', fromName: 'Ana Pérez', reason: 'ven', mediated: true });
    await acceptInvite(ROOM);
    expect(invites.getAll()).toHaveLength(0);
    expect(send.mock.calls[0]![0].attrs.to).toBe(`${ROOM}/yo`);
  });

  it('acepta invitaciones directas y rechaza avisando sólo a las mediadas', async () => {
    await feed(`<message from="luis@example.org/m"><x xmlns="jabber:x:conference" jid="otra@c.x" reason="hola"/></message>`);
    expect(invites.getAll()[0]).toMatchObject({ room: 'otra@c.x', fromName: 'luis', mediated: false });
    await declineInvite('otra@c.x');
    expect(send).not.toHaveBeenCalled();

    await feed(mediated);
    await declineInvite(ROOM);
    expect(send.mock.calls[0]![0].getChild('x').getChild('decline').attrs.to).toBe('ana@example.org');
    expect(invites.getAll()).toHaveLength(0);
  });
});

describe('reacciones, respuestas y retractación', () => {
  const reaction = (nick: string, emojis: string[]) => `<message from="${ROOM}/${nick}" type="groupchat">
    <reactions xmlns="urn:xmpp:reactions:0" id="sid-1">${emojis.map((e) => `<reaction>${e}</reaction>`).join('')}</reactions></message>`;

  it('agrega reacciones por remitente sobre el stanza-id y las persiste', async () => {
    messages.setConversation(ROOM, [groupMsg()]);
    await feed(reaction('ana', ['👍']));
    await feed(reaction('bob', ['👍']));
    await feed(reaction('ana', ['❤️']));
    expect(messages.getConversation(ROOM)[0]!.reactions).toEqual({ '👍': [`${ROOM}/bob`], '❤️': [`${ROOM}/ana`] });
    expect(XmppHistory.updateReactions).toHaveBeenCalledWith(ROOM, 'sid-1', `${ROOM}/ana`, ['❤️']);
    expect(messages.getConversation(ROOM)).toHaveLength(1); // no son burbujas
  });

  it('react() envía el conjunto con el stanza-id en groupchat', async () => {
    messages.setConversation(ROOM, [groupMsg({ id: 'cliente-1' })]);
    await joinRoom(ROOM, 'yo');
    send.mockClear();
    await react(ROOM, 'cliente-1', ['🎉']);
    const stanza = send.mock.calls[0]![0];
    expect(stanza.attrs.type).toBe('groupchat');
    expect(stanza.getChild('reactions').attrs.id).toBe('sid-1');
    expect(messages.getConversation(ROOM)[0]!.reactions).toEqual({ '🎉': [`${ROOM}/yo`] });
  });

  it('quita la cita del cuerpo y deja replyTo', async () => {
    await feed(`<message from="ana@example.org/x" type="chat" id="r1">
      <body>&gt; el original\nmi respuesta</body>
      <reply xmlns="urn:xmpp:reply:0" id="orig-1" to="yo@example.org"/>
      <fallback xmlns="urn:xmpp:fallback:0" for="urn:xmpp:reply:0"><body start="0" end="14"/></fallback></message>`);
    await new Promise((r) => setImmediate(r));
    const [m] = messages.getConversation('ana@example.org');
    expect(m!.body).toBe('mi respuesta');
    expect(m!.replyTo).toMatchObject({ id: 'orig-1', text: 'el original', sender: 'yo@example.org' });
    expect(XmppHistory.recordMessage).toHaveBeenCalledWith(
      'ana@example.org', 'mi respuesta', 'in', expect.any(String), null, expect.anything(), expect.anything(),
      'r1', null, null, null, null, null, false, expect.objectContaining({ replyTo: expect.objectContaining({ id: 'orig-1' }) }),
    );
  });

  it('sendMessage con replyTo arma <reply> y fallback', async () => {
    await sendMessage('ana@example.org', 'vale', 'chat', {
      replyTo: { id: 'orig-1', jid: 'ana@example.org', quotedText: 'hola' },
    });
    const stanza = send.mock.calls[0]![0];
    expect(stanza.getChildText('body')).toBe('> hola\nvale');
    expect(stanza.getChild('reply', 'urn:xmpp:reply:0').attrs.id).toBe('orig-1');
    expect(messages.getConversation('ana@example.org')[0]!.replyTo).toMatchObject({ id: 'orig-1', text: 'hola' });
  });

  it('retractación: lápida sólo si la envía el autor, el body se conserva', async () => {
    messages.setConversation(ROOM, [groupMsg()]);
    const retract = (nick: string) => `<message from="${ROOM}/${nick}" type="groupchat"><retract xmlns="urn:xmpp:message-retract:1" id="sid-1"/>
      <body>Este mensaje fue eliminado</body></message>`;
    await feed(retract('bob'));
    expect(messages.getConversation(ROOM)[0]!.retracted).toBeUndefined();
    await feed(retract('ana'));
    const [m] = messages.getConversation(ROOM);
    expect(m).toMatchObject({ retracted: true, body: 'hola' });
    expect(messages.getConversation(ROOM)).toHaveLength(1);
  });

  it('retractMessage() sólo acepta mensajes propios', async () => {
    messages.setConversation('ana@example.org', [
      { ...groupMsg(), type: 'chat', isGroup: false, from: 'ana@example.org', id: 'ajeno' },
      { ...groupMsg(), type: 'chat', isGroup: false, to: 'ana@example.org', direction: 'out', id: 'mio' },
    ]);
    await expect(retractMessage('ana@example.org', 'ajeno')).rejects.toThrow();
    await retractMessage('ana@example.org', 'mio');
    expect(send.mock.calls[0]![0].getChild('retract', 'urn:xmpp:message-retract:1').attrs.id).toBe('mio');
    expect(messages.getConversation('ana@example.org')[1]!.retracted).toBe(true);
  });

  it('el eco de nuestro groupchat aporta el stanza-id a nuestro mensaje saliente', async () => {
    await joinRoom(ROOM, 'yo');
    messages.setConversation(ROOM, [groupMsg({ id: 'mio-1', direction: 'out', stanzaId: null, senderNick: 'yo' })]);
    await feed(`<message from="${ROOM}/yo" type="groupchat" id="mio-1"><body>hola</body><stanza-id xmlns="urn:xmpp:sid:0" by="${ROOM}" id="sid-77"/></message>`);
    expect(messages.getConversation(ROOM)[0]!.stanzaId).toBe('sid-77');
    expect(XmppHistory.setMucStanzaId).toHaveBeenCalledWith(ROOM, 'mio-1', 'sid-77');
  });
});

describe('MAM de sala', () => {
  const wrap = (inner: string) => parse(`<result xmlns="urn:xmpp:mam:2" queryid="q" id="arch-9"><forwarded xmlns="urn:xmpp:forward:0">
    <delay xmlns="urn:xmpp:delay" stamp="2026-01-01T00:00:00Z"/>
    <message xmlns="jabber:client" type="groupchat" from="${ROOM}/ana" id="c1">${inner}</message></forwarded></result>`);

  it('usa el id de archivo como stanza-id y conserva el nick; reacciones y retractaciones son eventos', () => {
    const body = parseMamResult(wrap('<body>hola</body>'), ME, 'yo')!;
    expect(body).toMatchObject({ stanzaId: 'arch-9', senderNick: 'ana', direction: 'in', type: 'groupchat' });

    const reaction = parseMamResult(wrap('<reactions xmlns="urn:xmpp:reactions:0" id="sid-1"><reaction>👍</reaction></reactions>'), ME, 'yo')!;
    expect(reaction.reactionEvent).toEqual({ targetId: 'sid-1', emojis: ['👍'], sender: `${ROOM}/ana` });

    const retract = parseMamResult(wrap('<retract xmlns="urn:xmpp:message-retract:1" id="sid-1"/><body>Este mensaje fue eliminado</body>'), ME, 'yo')!;
    expect(retract.retractId).toBe('sid-1');
  });
});

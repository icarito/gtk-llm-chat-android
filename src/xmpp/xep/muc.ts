import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';

export const NS_MUC = 'http://jabber.org/protocol/muc';
export const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
export const NS_MUC_ADMIN = 'http://jabber.org/protocol/muc#admin';
export const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner';
export const NS_MUC_ROOMCONFIG = 'http://jabber.org/protocol/muc#roomconfig';
export const NS_DATA_FORMS = 'jabber:x:data';
export const NS_CONFERENCE_INVITE = 'jabber:x:conference';

export type MucRole = 'moderator' | 'participant' | 'visitor' | 'none';
export type MucAffiliation = 'owner' | 'admin' | 'member' | 'outcast' | 'none';

export interface JoinPresenceOptions {
  /** 0 por defecto: el historial de la sala se recupera por MAM, no por join. */
  historyMaxStanzas?: number;
  password?: string;
}

export interface MucPresence {
  room: string;
  nick: string;
  affiliation: string;
  role: string;
  realJid?: string;
  statusCodes: number[];
  /** Código 110: es nuestra propia presencia. */
  self: boolean;
  /** Código 307: expulsión (kick). */
  kicked: boolean;
  /** Código 301: veto (ban). */
  banned: boolean;
  /** Código 303: cambió de nick; el nuevo viene en `newNick`. */
  nickChanged: boolean;
  newNick?: string;
}

export interface MucInvite {
  room: string;
  from: string;
  reason?: string;
  password?: string;
}

export interface ConfigField {
  var: string;
  type?: string;
  values: string[];
}

export interface ParsedConfigField {
  var: string;
  type: string;
  values: string[];
}

function mucUserX(attrs: Record<string, string>, ...children: Element[]): Element {
  return xml('x', { xmlns: NS_MUC_USER, ...attrs }, ...children);
}

function adminItem(
  attrs: Record<string, string>,
  reason?: string,
): Element {
  const itemAttrs: Record<string, string> = { ...attrs };
  const children: Element[] = [];
  if (reason) children.push(xml('reason', {}, reason));
  return xml('item', itemAttrs, ...children);
}

export function buildJoinPresence(
  roomJid: string,
  nick: string,
  options: JoinPresenceOptions = {},
): Element {
  const historyMaxStanzas = options.historyMaxStanzas ?? 0;
  const xChildren: Element[] = [];
  if (historyMaxStanzas >= 0) {
    xChildren.push(xml('history', { maxstanzas: String(historyMaxStanzas) }));
  }
  if (options.password) {
    xChildren.push(xml('password', {}, options.password));
  }

  return xml(
    'presence',
    { to: `${roomJid}/${nick}` },
    xml('x', { xmlns: NS_MUC }, ...xChildren),
  );
}

export function parseMucPresence(pres: Element): MucPresence | null {
  const from = pres.attrs.from;
  if (!from) return null;

  const slash = from.indexOf('/');
  const room = slash < 0 ? from : from.slice(0, slash);
  const nick = slash < 0 ? '' : from.slice(slash + 1);

  const x = pres.getChild('x', NS_MUC_USER);
  if (!x) return null;

  const item = x.getChild('item');
  const statusCodes = x
    .getChildren('status')
    .map((status) => Number.parseInt(status.attrs.code ?? '', 10))
    .filter((code) => Number.isInteger(code));

  const result: MucPresence = {
    room,
    nick,
    affiliation: item?.attrs.affiliation ?? '',
    role: item?.attrs.role ?? '',
    statusCodes,
    self: statusCodes.includes(110),
    kicked: statusCodes.includes(307),
    banned: statusCodes.includes(301),
    nickChanged: statusCodes.includes(303),
  };

  if (item?.attrs.jid) result.realJid = item.attrs.jid;
  if (result.nickChanged && item?.attrs.nick) result.newNick = item.attrs.nick;

  return result;
}

export function buildSetRole(
  room: string,
  nick: string,
  role: MucRole,
  reason?: string,
): Element {
  return xml(
    'iq',
    { type: 'set', to: room },
    xml(
      'query',
      { xmlns: NS_MUC_ADMIN },
      adminItem({ nick, role }, reason),
    ),
  );
}

export function buildSetAffiliation(
  room: string,
  jid: string,
  affiliation: MucAffiliation,
  reason?: string,
): Element {
  return xml(
    'iq',
    { type: 'set', to: room },
    xml(
      'query',
      { xmlns: NS_MUC_ADMIN },
      adminItem({ jid, affiliation }, reason),
    ),
  );
}

/** Kick = rol `none` (XEP-0045 §9.2). */
export function buildKick(room: string, nick: string, reason?: string): Element {
  return buildSetRole(room, nick, 'none', reason);
}

/** Ban = afiliación `outcast` (XEP-0045 §9.1). */
export function buildBan(room: string, jid: string, reason?: string): Element {
  return buildSetAffiliation(room, jid, 'outcast', reason);
}

export function buildSetSubject(room: string, subject: string): Element {
  return xml(
    'message',
    { to: room, type: 'groupchat' },
    xml('subject', {}, subject),
  );
}

export function buildInvite(
  room: string,
  invitee: string,
  reason?: string,
): Element {
  const inviteChildren: Element[] = [];
  if (reason) inviteChildren.push(xml('reason', {}, reason));

  return xml(
    'message',
    { to: room },
    mucUserX({}, xml('invite', { to: invitee }, ...inviteChildren)),
  );
}

export function parseInvite(msg: Element): MucInvite | null {
  const x = msg.getChild('x', NS_MUC_USER);
  if (x) {
    const invite = x.getChild('invite');
    if (invite) {
      const inviteResult: MucInvite = {
        room: msg.attrs.from ?? '',
        from: invite.attrs.from ?? msg.attrs.from ?? '',
      };
      const reason = invite.getChild('reason');
      if (reason?.text()) inviteResult.reason = reason.text();
      const password = invite.getChild('password');
      if (password?.text()) inviteResult.password = password.text();
      return inviteResult;
    }
  }

  const direct = msg.getChild('x', NS_CONFERENCE_INVITE);
  if (direct?.attrs.jid) {
    const directResult: MucInvite = {
      room: direct.attrs.jid,
      from: msg.attrs.from ?? '',
    };
    const reason = direct.attrs.reason ?? direct.getChild('reason')?.text();
    if (reason) directResult.reason = reason;
    if (direct.attrs.password) directResult.password = direct.attrs.password;
    return directResult;
  }

  return null;
}

export function buildConfigGet(room: string): Element {
  return xml(
    'iq',
    { type: 'get', to: room },
    xml('query', { xmlns: NS_MUC_OWNER }),
  );
}

export function buildConfigSubmit(
  room: string,
  fields: ConfigField[],
): Element {
  const formFields: Element[] = [
    xml(
      'field',
      { var: 'FORM_TYPE', type: 'hidden' },
      xml('value', {}, NS_MUC_ROOMCONFIG),
    ),
  ];

  for (const field of fields) {
    if (!field.var || field.var === 'FORM_TYPE') continue;
    const attrs: Record<string, string> = { var: field.var };
    if (field.type) attrs.type = field.type;
    formFields.push(
      xml(
        'field',
        attrs,
        ...field.values.map((value) => xml('value', {}, value)),
      ),
    );
  }

  return xml(
    'iq',
    { type: 'set', to: room },
    xml(
      'query',
      { xmlns: NS_MUC_OWNER },
      xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' }, ...formFields),
    ),
  );
}

export function parseConfigForm(iq: Element): ParsedConfigField[] {
  const query = iq.getChild('query', NS_MUC_OWNER);
  if (!query) return [];
  const x = query.getChild('x', NS_DATA_FORMS);
  if (!x) return [];

  return x.getChildren('field').map((field) => ({
    var: field.attrs.var ?? '',
    type: field.attrs.type ?? '',
    values: field.getChildren('value').map((value) => value.text()),
  }));
}

export function roleLabel(role: string, affiliation: string): string {
  if (affiliation === 'owner') return 'dueño';
  if (affiliation === 'admin') return 'admin';
  if (role === 'moderator') return 'moderador';
  if (affiliation === 'member') return 'miembro';
  if (role === 'participant' || role === 'none') return 'participante';
  if (role === 'visitor') return 'visitante';
  return '';
}

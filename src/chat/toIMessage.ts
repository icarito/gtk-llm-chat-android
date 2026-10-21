import type { XmppMessage } from '@/types/xmpp';
import { displayName } from '@/xmpp/presence';
import { parseAttachment } from './attachments';

/** Tipos mínimos locales (antes venían de react-native-chat). */
export interface User {
  _id: string;
  name?: string;
}

export interface MessageReaction {
  emoji: string;
  userIds: string[];
}

export interface ReplyMessage {
  _id: string;
  text: string;
  user: User;
}

interface IMessageLike {
  _id: string;
  text: string;
  createdAt: number;
  user: User;
  image?: string;
  audio?: string;
  duration?: number;
  pending?: boolean;
  sent?: boolean;
  reactions?: MessageReaction[];
  replyMessage?: ReplyMessage;
}

/** Usuario local: nosotros decidimos el lado de la burbuja comparando `meta.mine`. */
export const ME: User = { _id: 'me' };

export const RETRACTED_TEXT = '_mensaje eliminado_';
const TOOL_RE = /^🛠️\s+Usando herramienta:/i;
/** Barato y conservador: sólo manda al renderer rico lo que de verdad lo necesita. */
const RICH_RE = /```|^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|/m;

/** Lo que las vistas propias necesitan y IMessage no modela. */
export interface MessageMeta {
  mine: boolean;
  sendState?: XmppMessage['sendState'];
  encryption?: XmppMessage['encryptionStatus'];
  /** Epoch ms de la última corrección XEP-0308; el "en curso" lo decide cada burbuja con su propio timer. */
  correctedAtMs?: number;
  fileUrl?: string;
  tool: boolean;
  /** Tiene bloques de código o tablas: usa el renderer rico en vez del markdown de la lib. */
  rich: boolean;
  /** Trae quick responses / comandos: puede alojar una tarjeta de aprobación. */
  actionable: boolean;
  retracted: boolean;
  stanzaId?: string | null;
  /** Hay algo que dibujar en renderCustomView; si no, se evita montar el componente. */
  extras: boolean;
}

export interface ChatMessage extends IMessageLike {
  meta: MessageMeta;
  /** Groupchat: JID real (bare) del remitente si se pudo resolver (avatares). */
  realJid?: string | null;
}

const users = new Map<string, User>();
function userFor(id: string, name?: string): User {
  const key = `${id}\0${name ?? ''}`;
  let user = users.get(key);
  if (!user) {
    user = name ? { _id: id, name } : { _id: id };
    users.set(key, user);
  }
  return user;
}

function senderOf(m: XmppMessage): User {
  if (m.direction === 'out') return ME;
  if (m.type === 'groupchat') {
    const nick = m.senderNick || m.from.split('/')[1] || m.from;
    return userFor(`${m.from.split('/')[0]}/${nick}`, nick);
  }
  return userFor(m.from.split('/')[0] ?? m.from);
}

function toReactions(
  reactions: XmppMessage['reactions'],
  self: ReadonlySet<string>,
): MessageReaction[] | undefined {
  if (!reactions) return undefined;
  const out = Object.entries(reactions)
    .filter(([, senders]) => senders.length > 0)
    .map(([emoji, senders]) => ({
      emoji,
      userIds: senders.map((s) => (self.has(s) ? ME._id : s)),
    }));
  return out.length ? out : undefined;
}

function toReply(m: XmppMessage): ReplyMessage | undefined {
  const r = m.replyTo;
  if (!r) return undefined;
  return {
    _id: r.id ?? '',
    text: r.text,
    user: userFor(r.sender, displayName(r.sender)),
  };
}

function build(m: XmppMessage, self: ReadonlySet<string>): ChatMessage {
  const mine = m.direction === 'out';
  const att = m.retracted ? null : parseAttachment(m.body, m.oobUrl, m.localUri);
  const text = m.retracted ? RETRACTED_TEXT : att ? att.text : m.body;
  const tool = !mine && TOOL_RE.test(text);
  const actionable = Boolean(m.quickResponses?.length || m.commands?.length);
  const failed = mine && m.sendState === 'failed';
  const fileUrl = att?.kind === 'file' ? att.url : undefined;
  const encryption = m.encryptionStatus;
  const duration = m.attachmentDuration ?? undefined;
  const reactions = toReactions(m.reactions, self);
  const replyMessage = toReply(m);

  return {
    _id: m.id,
    text,
    createdAt: Date.parse(m.timestamp),
    user: senderOf(m),
    ...(att?.kind === 'image' ? { image: att.url } : {}),
    ...(att?.kind === 'audio' ? { audio: att.url, ...(duration ? { duration } : {}) } : {}),
    ...(mine && m.sendState === 'pending' ? { pending: true } : {}),
    ...(mine && m.sendState === 'sent' ? { sent: true } : {}),
    ...(reactions ? { reactions } : {}),
    ...(replyMessage ? { replyMessage } : {}),
    realJid: m.senderRealJid ?? undefined,
    meta: {
      mine,
      sendState: m.sendState,
      encryption,
      correctedAtMs: mine ? undefined : m.correctedAtMs,
      fileUrl,
      tool,
      rich: !m.retracted && RICH_RE.test(text),
      actionable,
      retracted: Boolean(m.retracted),
      stanzaId: m.stanzaId,
      extras: Boolean(
        fileUrl || failed || encryption || actionable || (!mine && m.correctedAtMs !== undefined),
      ),
    },
  };
}

// Un IMessage por objeto XmppMessage: el store reemplaza (no muta) el mensaje
// cuando cambia, así que la identidad del objeto ES la versión. Mientras no
// cambie, devolvemos la MISMA referencia y la lista se salta la fila.
// `self` (nuestros ids de remitente, para marcar reacciones propias) forma parte
// de la clave: sólo cambia al unirse a otra sala, y entonces se reconstruye.
const cache = new WeakMap<XmppMessage, { self: ReadonlySet<string>; value: ChatMessage }>();

export function toIMessage(m: XmppMessage, self: ReadonlySet<string>): ChatMessage {
  const hit = cache.get(m);
  if (hit && hit.self === self) return hit.value;
  const value = build(m, self);
  cache.set(m, { self, value });
  return value;
}

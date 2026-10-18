export interface XmppAccountConfig {
  jid: string;
  password: string;
  service: string;
  resource: string;
  omemoEnabled?: boolean;
}

export type XmppConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'error';

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: 'online' | 'away' | 'dnd' | 'xa' | 'offline';
  status?: string;
  caps?: string | null;
}

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  type: 'chat' | 'groupchat';
  body: string;
  timestamp: string;
  /** Who sent it. Authoritative — never infer ownership from `from`, which is
   *  empty for locally-sent messages and bare for MAM ones. */
  direction: 'in' | 'out';
  /** XEP-0313 archive id, when the message came from (or was matched to) MAM. */
  mamId?: string | null;
  isMention?: boolean;
  isGroup: boolean;
  threadId?: string | null;
  quickResponses?: XmppQuickResponse[];
  commands?: XmppInlineCommand[];
  /** XEP-0461. `text` = cita (del fallback XEP-0428), `sender` = autor citado,
   *  `id` = id del mensaje citado (en groupchat, su stanza-id), `jid` = el `to` crudo. */
  replyTo?: {
    text: string;
    sender: string;
    id?: string;
    jid?: string;
  } | null;
  /** XEP-0359: id que el MUC asignó al mensaje; es el objetivo de reacciones/retractaciones en groupchat. */
  stanzaId?: string | null;
  /** Groupchat: nick del ocupante que lo envió (`from` es el bare de la sala). */
  senderNick?: string;
  /** XEP-0444 agregadas: emoji -> remitentes (bare JID en chat; `sala/nick` en groupchat). */
  reactions?: Record<string, string[]>;
  /** XEP-0424: el autor lo retractó. Se conserva como lápida (el body queda). */
  retracted?: boolean;
  oobUrl?: string | null;
  /** XEP-0454: file:// cacheado del adjunto aesgcm ya descifrado. */
  localUri?: string | null;
  attachmentDuration?: number | null;
  attachmentMimeType?: string | null;
  /** Epoch ms de la última corrección XEP-0308 aplicada — mientras sea
   *  reciente, la burbuja se pinta como "en curso" (streaming del gateway). */
  correctedAtMs?: number;
  /** Solo salientes: pending hasta que el socket acepta, failed si el envío
   *  lanzó — la UI ofrece reintentar. */
  sendState?: 'pending' | 'sent' | 'failed';
  wasEncrypted?: boolean;
  /** Derived from the actual stanza, never from the account setting.
   *  'encrypted' = fila del historial sin protocolo conocido (sólo guardamos un booleano). */
  encryptionStatus?: 'omemo2' | 'omemo' | 'none' | 'undecryptable' | 'encrypted';
  /** XEP-0308 target when this archived stanza corrects an earlier message. */
  replaceId?: string | null;
  /** Sólo MAM: esta stanza archivada retracta (XEP-0424) el mensaje `retractId`; no es una burbuja. */
  retractId?: string | null;
  /** Sólo MAM: esta stanza archivada es un evento de reacciones (XEP-0444), no una burbuja. */
  reactionEvent?: { targetId: string; emojis: string[]; sender: string } | null;
}

export type RoomState = 'joining' | 'joined' | 'left' | 'kicked' | 'banned' | 'error';

export interface RoomOccupant {
  nick: string;
  realJid?: string;
  role: string;
  affiliation: string;
  isAgent: boolean;
}

export interface XmppRoom {
  jid: string;
  name?: string;
  subject?: string;
  nick: string;
  state: RoomState;
  /** Condición de error (p. ej. `conflict`, `not-authorized`) si state === 'error'. */
  error?: string;
  bookmarked: boolean;
  /** Valor del marcador XEP-0402 (sólo con `bookmarked`). */
  autojoin?: boolean;
  occupants: Record<string, RoomOccupant>;
  /** Nuestro rol/afiliación, tomados de la presencia propia (110). */
  role: string;
  affiliation: string;
  /** disco#info de la sala (XEP-0045 muc_nonanonymous / muc_membersonly); undefined hasta consultarla. */
  nonAnonymous?: boolean;
  membersOnly?: boolean;
  /** Por qué no hay OMEMO 2 en la sala (para la UI); sólo con nonAnonymous === false. */
  omemoUnavailableReason?: string;
  /** Destinatarios que quedaron sin clave en el último envío cifrado. */
  omemoSkipped?: number;
}

/** Invitación a sala pendiente de aceptar/rechazar (mediada XEP-0045 o directa XEP-0249). */
export interface XmppRoomInvite {
  id: string;
  room: string;
  roomName: string;
  from: string;
  fromName: string;
  reason?: string;
  password?: string;
  mediated: boolean;
  timestamp: string;
}

/** Button color hint (paridad con Telegram / GTK). */
export type XmppButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface XmppQuickResponse {
  label: string;
  value: string;
  style?: XmppButtonStyle;
  /** Epoch ms tras el cual el botón caduca (XEP-0439 expires-at-ms). */
  expiresAtMs?: number;
}

export interface XmppInlineCommand {
  jid: string;
  node: string;
  name: string;
  style?: XmppButtonStyle;
  /** Epoch ms tras el cual el botón caduca (lo emite el plugin, igual que en <response>). */
  expiresAtMs?: number;
}

export interface XmppPendingAction {
  id: string;
  conversationJid: string;
  messageId: string;
  timestamp: string;
  /** Resumen corto para la tarjeta (warning + comando). */
  detail: string;
  /**
   * Cuerpo completo del mensaje, para la vista expandida. `detail` viene
   * recortado por extractApprovalSummary (descarta cwd y expiración), así que
   * sin esto el botón de info mostraba exactamente el mismo texto que la
   * tarjeta y no revelaba nada nuevo.
   */
  detailFull?: string;
  kind: 'quick-response' | 'command';
  label: string;
  value?: string;
  jid?: string;
  node?: string;
  style?: XmppButtonStyle;
  expiresAtMs?: number;
  /** Decision accepted by XMPP; kept visible until gateway resolution arrives. */
  submitted?: boolean;
}

export interface ActionParam {
  name: string;
  label: string;
  type: 'text-single' | 'text-multi' | 'list-single' | 'list-multi' | 'boolean' | 'jid-single';
  required: boolean;
  description?: string;
  options?: { label: string; value: string }[];
  default?: string;
}

export interface ActionContext {
  fromJid: string;
  agentGroupId: string | null;
}

export interface NanoClawAction {
  node: string;
  name: string;
  description: string;
  params: ActionParam[];
  mutating: boolean;
  kind?: 'static' | 'skill';
  skillPrompt?: string;
  handler: (params: Record<string, string>, ctx?: ActionContext) => Promise<string> | string;
}

export interface ActionDispatcher {
  listActions(): NanoClawAction[];
  getAction(node: string): NanoClawAction | undefined;
  execute(node: string, params: Record<string, string>, ctx?: ActionContext): Promise<string>;
  registerAction(action: NanoClawAction): void;
  unregisterAction(node: string): void;
}

export interface PendingXmppQuestion {
  questionId: string;
  platformId: string;
  options: { label: string; value: string }[];
  messageId: string;
  shortId: string;
  title: string;
  question: string;
  actionNodes: string[];
  type: string;
}

export interface FormField {
  var: string;
  type?:
    | 'boolean'
    | 'fixed'
    | 'hidden'
    | 'jid-multi'
    | 'jid-single'
    | 'list-multi'
    | 'list-single'
    | 'text-multi'
    | 'text-single';
  label?: string;
  value?: string | string[];
  desc?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
}

export type FormType = 'form' | 'submit' | 'result' | 'cancel';

export interface DataForm {
  type: FormType;
  title?: string;
  instructions?: string[];
  fields: FormField[];
}

export interface PendingTextualCommand {
  node: string;
  jid: string;
  collected: Map<string, string>;
  remaining: {
    name: string;
    label: string;
    type: string;
    options?: { label: string; value: string }[];
    required: boolean;
  }[];
  currentParamIdx: number;
}

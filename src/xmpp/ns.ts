/** Namespaces y nodos XMPP compartidos por los módulos de src/xmpp. */

export const QUICK_RESPONSE_NS = 'urn:xmpp:quick-response:0';
export const LEGACY_QUICK_RESPONSE_NS = 'urn:xmpp:tmp:quick-response';
export const MESSAGE_CORRECT_NS = 'urn:xmpp:message-correct:0';
// XEP-0085: estados de chat ("escribiendo…"). El gateway los emite mientras
// el agente trabaja; nosotros los emitimos al teclear.
export const CHAT_STATES_NS = 'http://jabber.org/protocol/chatstates';
export const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';
export const COMMAND_NS = 'http://jabber.org/protocol/commands';
export const PUBSUB_EVENT_NS = 'http://jabber.org/protocol/pubsub#event';
export const PUSH_NS = 'urn:xmpp:push:0';
// XEP-0066 (OOB): envoltorio del link de un adjunto. XEP-0363 (HTTP Upload):
// descubrimiento del componente y pedido de slot.
export const OOB_NS = 'jabber:x:oob';
export const HTTP_UPLOAD_NS = 'urn:xmpp:http:upload:0';
// Telemetría del agente (contexto, tokens, coste, modelo). Va por PEP y no en el
// <status> de la presencia: el status es texto para humanos —cualquier cliente lo
// pinta tal cual junto al contacto— y estos números cambian a cada token.
// El nodo lo fija el servidor del agente (proyecto renombrado de NanoClaw a
// OpenClaw), no nosotros — ver TELEMETRY_NODE en src/channels/xmpp.ts del
// gateway. Un agente aún no migrado sigue publicando bajo el nodo legacy.
export const TELEMETRY_NODE = 'urn:openclaw:telemetry:0';
export const LEGACY_TELEMETRY_NODE = 'urn:nanoclaw:telemetry:0';

// Avatares XEP-0084: el contacto anuncia el hash de su foto en el nodo de
// metadata y sirve los bytes (base64) en el de data, que se piden a demanda.
export const AVATAR_METADATA_NODE = 'urn:xmpp:avatar:metadata';
export const AVATAR_DATA_NODE = 'urn:xmpp:avatar:data';
export const PUBSUB_NS = 'http://jabber.org/protocol/pubsub';
export const DISCO_INFO_NS = 'http://jabber.org/protocol/disco#info';

export const CAPS_NODE = 'https://github.com/icarito/gtk-llm-chat-android';

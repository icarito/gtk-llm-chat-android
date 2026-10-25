/**
 * Tipos del núcleo Jingle (XEP-0166/0167/0176/0320) + iniciación por
 * mensaje (XEP-0353). Puro TS, sin dependencias de UI ni de react-native:
 * es la capa que se testea y que puede cablearse a cualquier motor de
 * medios (react-native-webrtc en Android/iOS).
 */

export const JINGLE_NS = 'urn:xmpp:jingle:1';
export const RTP_NS = 'urn:xmpp:jingle:apps:rtp:1';
export const ICE_UDP_NS = 'urn:xmpp:jingle:transports:ice-udp:1';
export const DTLS_SRTP_NS = 'urn:xmpp:jingle:transports:dtls-srtp:1';
export const MESSAGE_NS = 'urn:xmpp:jingle-message:0';
export const RTP_FEEDBACK_NS = 'urn:xmpp:jingle:apps:rtp:rtcp-fb:0';

export type JingleRole = 'initiator' | 'responder';

export type JingleAction =
  | 'session-initiate'
  | 'session-accept'
  | 'transport-info'
  | 'session-terminate'
  | 'session-info'
  | 'content-add'
  | 'content-modify'
  | 'content-reject'
  | 'transport-replace'
  | 'transport-accept'
  | 'transport-reject'
  | 'security-info';

export type SessionState = 'pending' | 'active' | 'ended';

export type Senders = 'both' | 'initiator' | 'responder' | 'none';

/** Payload RTP (XEP-0167 <payload-type/>). */
export interface RtpPayload {
  id: string;
  name: string;
  clockrate?: number;
  channels?: number;
  parameters?: Record<string, string>;
}

/** Descripción RTP de un content (XEP-0167 <description xmlns="...rtp">). */
export interface RtpDescription {
  media: 'audio' | 'video';
  senders: Senders;
  payloads: RtpPayload[];
  /** ssrc entrante si el remoto la declara (habitual en video). */
  ssrc?: string;
  /** URNs de feedback negociado (XEP-0293), p.ej. "transport-cc". */
  feedback?: string[];
}

/** Candidato ICE XEP-0176 <candidate/>. */
export interface IceCandidate {
  component: number;
  foundation: string;
  generation?: number;
  id?: string;
  ip: string;
  port: number;
  priority: number;
  protocol: 'udp' | 'tcp';
  type: 'host' | 'srflx' | 'prflx' | 'relay';
  relAddr?: string;
  relPort?: number;
}

/** Transporte ICE-UDP de un content (XEP-0176 + XEP-0320). */
export interface IceUdpTransport {
  ufrag: string;
  pwd: string;
  candidates: IceCandidate[];
  /** Huella DTLS-SRTP (XEP-0320). */
  fingerprint?: {
    hash: string;
    value: string;
    setup?: 'actpass' | 'active' | 'passive';
  };
}

/** Un content de sesión Jingle. */
export interface JingleContent {
  name: string;
  creator: JingleRole;
  senders: Senders;
  transport: IceUdpTransport;
  rtp?: RtpDescription;
}

/** Estado de una sesión Jingle. */
export interface JingleSessionMeta {
  id: string;
  /** JID completo del peer (con recurso). */
  peer: string;
  /** JID completo del iniciador. */
  initiator: string;
  /** JID completo del responder (una vez conocido). */
  responder?: string;
  role: JingleRole;
  state: SessionState;
  contents: JingleContent[];
  /** Sólo audio en esta fase; 'video' en fase 2. */
  media: 'audio' | 'video';
}

/** Razones de terminación XEP-0166 (algunas). */
export type JingleReason =
  | 'cancel'
  | 'success'
  | 'decline'
  | 'busy'
  | 'media-error'
  | 'connectivity-error'
  | 'expired'
  | 'failed-application'
  | 'failed-transport'
  | 'unsupported-applications'
  | 'timeout';

/** Envelope XEP-0353 (jingle-message). */
export interface JingleMessage {
  action: 'propose' | 'accept' | 'reject' | 'ringing' | 'retract' | 'proceed' | 'finish';
  id: string;
  /** sólo en propose (el XEP exige una description por tipo de medio). */
  description?: { media: 'audio' | 'video' };
}

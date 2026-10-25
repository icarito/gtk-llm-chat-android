/**
 * Orquestación de llamadas Jingle 1:1 (audio). Une el núcleo puro
 * (JingleSession/message/transport) con el motor de medios
 * (react-native-webrtc) y el router de stanzas.
 */
import { xml } from '@xmpp/xml';
import type { Element } from '@xmpp/xml';
import type { StanzaCtx } from '@/xmpp/session';
import { session, usableClient } from '@/xmpp/session';
import { bareJid } from '@/xmpp/parse';
import { JINGLE_NS } from './types';
import { buildJingleMessage, parseJingleMessage, unwrapCarbonJingleMessage } from './message';
import { JingleSession } from './session';
import type { IceCandidate } from './types';
import type { WebrtcBridge } from './webrtcAdapter';
import { calls } from './callsStore';
import type { CallState } from './callsStore';
import { notifyIncomingCall } from '@/xmpp/notifications';
import { fetchTurnServers } from './turn';

const activeSessions = new Map<string, JingleSession>();
let activeBridge: WebrtcBridge | null = null;
let pendingOutgoing: { sid: string; peer: string } | null = null;
let pendingIncoming: { sid: string; peer: string } | null = null;
let turnFetch: Promise<{ urls: string[]; username?: string; credential?: string }[]> | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let failTimer: ReturnType<typeof setTimeout> | null = null;

/** Si nadie contesta, no dejar el estado ringing para siempre en ningún lado
 *  (Dino corta por su lado; nosotros retract/decline explícito). */
const RING_TIMEOUT_MS = 60_000;

/** Falla visible: no desaparecer sin rastro; la overlay muestra la tarjeta
 *  "Llamada fallida" y se cierra sola unos segundos. */
const FAIL_CLEAR_MS = 4_000;

async function applyTurn(rtc: WebrtcBridge): Promise<void> {
  if (!turnFetch) turnFetch = fetchTurnServers().catch(() => []);
  const servers = await turnFetch;
  if (servers.length > 0) rtc.setIceServers(servers);
}

function clientSend(el: Element): Promise<void> {
  const client = usableClient();
  if (!client) return Promise.reject(new Error('XMPP no conectado'));
  return client.send(el);
}

function callId(): string {
  return `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function disarmRingTimeout(): void {
  if (ringTimer) {
    clearTimeout(ringTimer);
    ringTimer = null;
  }
}

function armRingTimeout(sid: string): void {
  disarmRingTimeout();
  ringTimer = setTimeout(() => {
    ringTimer = null;
    const cur = calls.getSnapshot();
    if (cur && cur.sid === sid && cur.phase === 'ringing') void hangup();
  }, RING_TIMEOUT_MS);
}

function setCall(patch: Partial<CallState>): void {
  const current = calls.getSnapshot();
  if (!current) return;
  calls.set({ ...current, ...patch });
  if (patch.phase && patch.phase !== 'ringing') disarmRingTimeout();
}

function clearCall(): void {
  disarmRingTimeout();
  if (failTimer) {
    clearTimeout(failTimer);
    failTimer = null;
  }
  calls.set(null);
  pendingOutgoing = null;
  pendingIncoming = null;
}

/** Falla visible: no desaparecer sin rastro; la overlay muestra la tarjeta
 *  "Llamada fallida" y se cierra sola unos segundos. */
function failCall(where: string, error: unknown): void {
  disarmRingTimeout();
  // eslint-disable-next-line no-console
  console.warn(`[jingle] ${where}:`, error);
  setCall({ phase: 'failed' });
  failTimer = setTimeout(() => {
    failTimer = null;
    const cur = calls.getSnapshot();
    if (cur && cur.phase === 'failed') clearCall();
  }, FAIL_CLEAR_MS);
}

async function makeIce(peer: string, sid: string, role: 'initiator' | 'responder', media: 'audio', initiator: string, responder: string) {
  const { WebrtcBridge } = await import('./webrtcAdapter');
  const sessRef: { current: JingleSession | null } = { current: null };
  const rtc = new WebrtcBridge({ audio: true, video: false }, {
    onLocalCandidate: (candidate) => {
      const parsed = candidateFromSdp(candidate.candidate);
      if (parsed) void sessRef.current?.sendLocalCandidates([parsed]);
    },
    onRemoteStream: (stream) => setCall({ stream }),
    // ICE/DTLS falló (o el motor cerró solo): XEP-0166 exige terminar la
    // sesión, no dejar que el chat siga "en llamada" eternamente.
    onClosed: () => {
      const s = sessRef.current;
      if (!s || s.getState() === 'ended') return;
      void s.terminate('connectivity-error').catch(() => {});
      failCall('el motor RTC cerró la conexión', null);
    },
  });
  const sess = new JingleSession({
    id: sid,
    peer,
    role,
    initiator,
    responder,
    media,
    send: clientSend,
    rtc,
    callbacks: {
      onLocalCandidate: (contentName, c: IceCandidate) => {
        void sess.sendTransportInfo(contentName, [c]);
      },
      onRemoteStream: (stream) => setCall({ stream }),
      onStateChange: (state) => {
        if (state === 'active') setCall({ phase: 'active' });
        else if (state === 'ended') {
          // Si la llamada está pintada como failed, dejar que el timer la
          // cierre (la tarjeta debe verse unos segundos).
          const cur = calls.getSnapshot();
          if (cur?.phase === 'failed') return;
          clearCall();
        }
      },
    },
  });
  sessRef.current = sess;
  activeBridge = rtc;
  return { rtc, sess };
}

/** Silencia/activa el micrófono local de la llamada activa. */
export function setMicrophoneMuted(muted: boolean): void {
  activeBridge?.setMicrophoneMuted(muted);
}

function candidateFromSdp(line: string): IceCandidate | null {
  const m = /^candidate:(.+)$/.exec(line.trim());
  if (!m) return null;
  const parts = m[1]!.split(' ');
  const [foundation, component, protocol, priority, ip, port, , type] = parts;
  if (!foundation || !component || !protocol || !priority || !ip || !port || !type) return null;
  const c: IceCandidate = {
    foundation,
    component: Number(component),
    protocol: protocol as 'udp' | 'tcp',
    priority: Number(priority),
    ip,
    port: Number(port),
    type: type as IceCandidate['type'],
  };
  const raddrIdx = parts.indexOf('raddr');
  if (raddrIdx >= 0 && parts[raddrIdx + 1]) {
    c.relAddr = parts[raddrIdx + 1]!;
    c.relPort = Number(parts[raddrIdx + 2] ?? 0);
  }
  return c;
}

/** Inicia una llamada saliente: XEP-0353 propose y espera accept. */
export async function startCall(peerJid: string): Promise<void> {
  const account = session.account;
  if (!account || !usableClient()) throw new Error('Conéctate para llamar');
  if (calls.getSnapshot()) throw new Error('Ya hay una llamada activa');
  const sid = callId();
  pendingOutgoing = { sid, peer: peerJid };
  calls.set({ sid, peer: peerJid, direction: 'outgoing', phase: 'ringing', media: 'audio' });
  armRingTimeout(sid);
  const propose = buildJingleMessage('propose', { id: sid, media: 'audio' });
  propose.attrs.to = peerJid;
  // eslint-disable-next-line no-console
  console.warn(`[jingle] envío propose ${sid} a ${peerJid}`);
  await clientSend(propose);
}

/** Acepta la llamada entrante: responde proceed (XEP-0353 §3.4) y espera
 *  session-initiate. El <accept/> de XEP-0353 NO significa "acepto" ante el
 *  iniciador: es el aviso interno entre los dispositivos del responder. */
export function answerCall(): void {
  const current = calls.getSnapshot();
  if (!current || current.direction !== 'incoming') return;
  pendingIncoming = { sid: current.sid, peer: current.peer };
  disarmRingTimeout();
  setCall({ phase: 'connecting' });
  const proceed = buildJingleMessage('proceed', { id: current.sid });
  proceed.attrs.to = current.peer;
  void clientSend(proceed).catch(() => clearCall());
}

/** Rechaza la llamada entrante. */
export function declineCall(): void {
  const current = calls.getSnapshot();
  if (!current || current.direction !== 'incoming') return;
  const reject = buildJingleMessage('reject', { id: current.sid, media: current.media });
  reject.attrs.to = current.peer;
  void clientSend(reject).catch(() => {});
  clearCall();
}

/** Cuelga la llamada activa (o cancela la saliente). */
export async function hangup(): Promise<void> {
  const current = calls.getSnapshot();
  if (!current) return;
  if (current.direction === 'incoming' && (current.phase === 'ringing' || current.phase === 'connecting')) {
    declineCall();
    return;
  }
  // Saliente sin contestar: avisar al peer con retract (XEP-0353) para que
  // no se quede con una llamada "en curso" (Dino deshabilita el botón).
  if (current.direction === 'outgoing' && current.phase === 'ringing') {
    const retract = buildJingleMessage('retract', { id: current.sid, media: current.media });
    retract.attrs.to = current.peer;
    void clientSend(retract).catch(() => {});
    clearCall();
    return;
  }
  const sess = activeSessions.get(current.sid);
  if (sess) {
    activeSessions.delete(current.sid);
    await sess.terminate(current.direction === 'outgoing' ? 'cancel' : 'success');
  }
  // XEP-0353 v0.8 §3.7: <finish/> sincroniza el fin de la llamada en todos
  // los dispositivos / MAM; los clientes que sólo conocen la versión antigua
  // ignoran el elemento.
  try {
    const finish = buildJingleMessage('finish', { id: current.sid });
    finish.attrs.to = current.peer;
    void clientSend(finish).catch(() => {});
  } catch { /* si la conexión ya cayó, session-terminate igual no llegó */ }
  clearCall();
}

/** Router: <message> con jingle-message (XEP-0353), directo o dentro de un
 *  carbon (XEP-0280). */
export async function handleJingleMessage(stanza: Element, _ctx: StanzaCtx): Promise<boolean> {
  let msg = parseJingleMessage(stanza);
  // XEP-0353 + mod_message de Prosody: los mensajes SIN body (el propose)
  // van sólo al top_resources de la cuenta; en el resto de dispositivos
  // llegan como carbons de NUESTRA cuenta (<received><forwarded>). Sin
  // unwrap, cuando otro dispositivo tuyo tenía top priority, el teléfono
  // ni se enteraba: "llaman y no pasa nada".
  let senderFrom = (stanza.attrs.from as string) ?? '';
  if (!msg) {
    const carbon = unwrapCarbonJingleMessage(stanza);
    // XEP-0280 §6: el wrapper SIEMPRE viene de nuestra propia cuenta; un
    // "carbon" de otra JID es suplantación y se ignora.
    if (!carbon) return false;
    const wrapperFrom = bareJid(senderFrom);
    const ownBareForCarbon = bareJid(session.account?.jid ?? '');
    if (!ownBareForCarbon || wrapperFrom !== ownBareForCarbon) return false;
    msg = parseJingleMessage(carbon.message);
    if (!msg) return false;
    // El receptor REAL del jingle-message es el remitente del mensaje interior
    // (el peer), no el wrapper (nuestra cuenta).
    senderFrom = (carbon.message.attrs.from as string) ?? '';
  }
  if (!msg) return false;
  const from = senderFrom;
  const fromBare = bareJid(from);
  if (!from) return false;
  const ownBare = bareJid(session.account?.jid ?? '');
  // Eco de NUESTRA cuenta (carbons de otros dispositivos): según la acción,
  // sincroniza estado local (un dispositivo propio atendió/colgó) y nunca
  // mostrar el modal por un propose propio.
  if (ownBare && fromBare === ownBare) {
    switch (msg.action) {
      case 'proceed':
      case 'accept':
        // Otro device nuestro atendió: dejar de sonar acá.
        if (pendingIncoming?.sid === msg.id || calls.getSnapshot()?.sid === msg.id) clearCall();
        return true;
      case 'reject':
      case 'retract':
      case 'finish': {
        if (
          pendingOutgoing?.sid === msg.id ||
          pendingIncoming?.sid === msg.id ||
          calls.getSnapshot()?.sid === msg.id
        ) {
          const sess = activeSessions.get(msg.id);
          if (sess) {
            activeSessions.delete(msg.id);
            try { await sess.terminate('success'); } catch { /* ya corta */ }
          }
          clearCall();
        }
        return true;
      }
      default:
        return true;
    }
  }
  // eslint-disable-next-line no-console
  console.warn(`[jingle] message ${msg.action} ${msg.id} de ${from}`);
  switch (msg.action) {
    case 'propose': {
      if (msg.description?.media === 'video') {
        // Fase 1 sólo audio: rechazamos video de forma explícita (no se
        // confunde con el botón de Dino y evita una sesión rota).
        void clientSend(buildJingleMessage('reject', { id: msg.id })).catch(() => {});
        return true;
      }
      if (calls.getSnapshot()) {
        void clientSend(buildJingleMessage('reject', { id: msg.id })).catch(() => {});
        return true;
      }
      pendingIncoming = { sid: msg.id, peer: from };
      calls.set({ sid: msg.id, peer: from, direction: 'incoming', phase: 'ringing', media: 'audio' });
      armRingTimeout(msg.id);
      // XEP-0353 §3.2: avisar que este dispositivo está sonando (el
      // iniciador lo muestra como "Ringing...").
      const ringing = buildJingleMessage('ringing', { id: msg.id });
      ringing.attrs.to = from;
      void clientSend(ringing).catch(() => {});
      void notifyIncomingCall(fromBare).catch(() => {});
      return true;
    }
    case 'accept':
    case 'proceed': {
      // <accept/> puede llegar de un peer que use la variante antigua del
      // XEP: mismo tratamiento que proceed (su device aceptó la llamada).
      if (!pendingOutgoing || pendingOutgoing.sid !== msg.id) return true;
      const account = session.account;
      if (!account) return true;
      const sid = pendingOutgoing.sid;
      // XEP-0353 §3.6: el session-initiate va al FULL JID del dispositivo
      // que respondió (el bare iría al recurso equivocado o a nadie).
      const peerFrom = from;
      const current = calls.getSnapshot();
      if (!current) return true;
      setCall({ phase: 'connecting' });
      try {
        const { rtc, sess } = await makeIce(peerFrom, sid, 'initiator', 'audio', account.jid, peerFrom);
        await applyTurn(rtc);
        await rtc.startMedia();
        activeSessions.set(sid, sess);
        await sess.initiate();
      } catch (e) {
        failCall('fallo al iniciar sesión saliente', e);
        try {
          const retract = buildJingleMessage('retract', { id: sid });
          retract.attrs.to = current.peer;
          void clientSend(retract).catch(() => {});
        } catch { /* sin conexión: nada que retractar */ }
      }
      return true;
    }
    case 'reject': {
      if (pendingOutgoing && pendingOutgoing.sid === msg.id) clearCall();
      return true;
    }
    case 'ringing': {
      if (pendingOutgoing && pendingOutgoing.sid === msg.id) setCall({ phase: 'ringing' });
      return true;
    }
    case 'retract': {
      if (pendingIncoming && pendingIncoming.sid === msg.id) clearCall();
      return true;
    }
    case 'finish': {
      // XEP-0353 §3.7: fin de la llamada anunciado por mensaje (los clientes
      // 0.8 lo envían además del session-terminate; otro device puede
      // cerrarlo por su lado). Limpia cualquier estado del sid.
      const sess = activeSessions.get(msg.id);
      if (sess) {
        activeSessions.delete(msg.id);
        try { await sess.terminate('success'); } catch { /* el RTC ya está cerrado */ }
      }
      if (pendingOutgoing?.sid === msg.id || pendingIncoming?.sid === msg.id) {
        clearCall();
        return true;
      }
      if (calls.getSnapshot()?.sid === msg.id) clearCall();
      return true;
    }
    default:
      return false;
  }
}

/** Router: <iq type="set"> con <jingle> (XEP-0166). */
export async function handleJingleIq(stanza: Element, _ctx: StanzaCtx): Promise<boolean> {
  if (!stanza.is('iq')) return false;
  const jingleEl = stanza.getChild('jingle', JINGLE_NS);
  if (!jingleEl) return false;
  const action = jingleEl.attrs.action as string | undefined;
  const sid = jingleEl.attrs.sid as string | undefined;
  const from = (stanza.attrs.from as string) ?? '';
  if (!action || !sid) return false;
  // eslint-disable-next-line no-console
  console.warn(`[jingle] iq ${action} ${sid} de ${from}`);

  const ack = () => void clientSend(xml('iq', { type: 'result', to: from, id: stanza.attrs.id })).catch(() => {});

  let sess = activeSessions.get(sid);
  if (!sess) {
    if (action !== 'session-initiate') {
      ack();
      return true;
    }
    // Fase 1 sólo audio: si el remoto inicia video, rechazamos explícito
    // (no SDP de audio mangleado que Dino interpreta como fallo).
    const hasVideo = jingleEl.getChildren('content').some((c) =>
      c.getChild('description')?.attrs.media === 'video');
    if (hasVideo) {
      void clientSend(xml('iq', { type: 'set', to: from, id: `${sid}-terminate-video` },
        xml('jingle', { xmlns: JINGLE_NS, action: 'session-terminate', sid, initiator: from },
          xml('reason', {}, xml('unsupported-applications', {}))))).catch(() => {});
      ack();
      return true;
    }
    const account = session.account;
    if (!account) return true;
    const initiator = (jingleEl.attrs.initiator as string) ?? from;
    const media = 'audio' as const;
    try {
      const created = await makeIce(from, sid, 'responder', media, initiator, account.jid);
      await applyTurn(created.rtc);
      await created.rtc.startMedia();
      sess = created.sess;
      activeSessions.set(sid, sess);
    } catch (e) {
      void clientSend(xml('iq', { type: 'error', to: from, id: stanza.attrs.id })).catch(() => {});
      if (calls.getSnapshot()?.sid === sid) failCall('fallo al preparar sesión entrante', e);
      else console.warn('[jingle] fallo al preparar sesión entrante', e);
      return true;
    }
  }

  await sess.handleElement(action as never, jingleEl);
  ack();

  // Después de session-initiate hay que responder session-accept de una:
  // nadie más va a llamar a accept() (el modal ya respondió el proceed) y
  // sin esto el iniciador queda esperando hasta su timeout. Sólo en fase
  // 'connecting' (el usuario aceptó explícitamente y enviamos proceed);
  // un session-initiate fuera de ese estado se declina (jamás auto-aceptar
  // sin confirmación, XEP-0353 §Security).
  if (action === 'session-initiate') {
    const current = calls.getSnapshot();
    if (current?.sid === sid && current.phase === 'connecting') {
      try {
        await sess.accept();
      } catch (e) {
        try { await sess.terminate('failed-application'); } catch { /* ya está corta */ }
        activeSessions.delete(sid);
        failCall('fallo al aceptar sesión', e);
      }
    } else {
      try { await sess.terminate('decline'); } catch { /* sin conexión; igual limpiamos */ }
      activeSessions.delete(sid);
      if (current?.sid === sid) clearCall();
    }
  }
  return true;
}

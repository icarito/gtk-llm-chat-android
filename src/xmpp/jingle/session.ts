import { xml } from '@xmpp/xml';
import type { Element } from '@xmpp/xml';
import { JINGLE_NS, RTP_NS, ICE_UDP_NS } from './types';
import type {
  JingleRole,
  JingleAction,
  SessionState,
  Senders,
  RtpPayload,
  RtpDescription,
  JingleContent,
  JingleReason,
  IceCandidate,
  IceUdpTransport,
} from './types';
import {
  buildIceUdpTransport,
  buildCandidateElement,
  candidateToSdp,
  fingerprintFromSdp,
  iceCredentialsFromSdp,
  parseCandidateElement,
  parseIceUdpTransport,
} from './transport';
import type { RtcBridge, RtcIceCandidateInit } from './rtcBridge';

export interface JingleSend {
  (el: Element): Promise<void>;
}

export interface JingleSessionCallbacks {
  onLocalCandidate(contentName: string, c: IceCandidate): void;
  onRemoteStream(stream: unknown): void;
  onStateChange(state: SessionState): void;
}

export interface JingleSessionOpts {
  id: string;
  peer: string;
  role: JingleRole;
  initiator: string;
  responder?: string;
  media: 'audio' | 'video';
  send: JingleSend;
  rtc: RtcBridge;
  callbacks: JingleSessionCallbacks;
}

/**
 * Reconstruye un SDP "mínimo pero válido" a partir de un content Jingle,
 * para darlo de comer a libwebrtc (setRemoteDescription). Sin
 * `a=mid`/`a=rtcp-mux`/`a=setup` el motor lo rechaza y la llamada muere en
 * setRemoteDescription (antes: sólo payload[0] y sin setup → createAnswer
 * fallaba silenciosamente). Incluye TODOS los payload-types del content
 * (Dino ofrece varios; responder con uno solo ajeno rompe el match de códec).
 *
 * kind: 'offer' → ponemos a=setup:actpass (rol ofrecido por el remoto);
 * kind: 'answer' → el remoto ya respondió; usamos su setup o activo.
 */
export function sdpFromContent(content: JingleContent, kind: 'offer' | 'answer' = 'answer'): string {
  const fingerprint = content.transport.fingerprint;
  const setup = fingerprint?.setup ?? (kind === 'offer' ? 'actpass' : 'active');
  const media = content.rtp?.media ?? (content.name === 'video' ? 'video' : 'audio');
  const payloads = content.rtp?.payloads ?? [];
  const ptIds = payloads.length > 0 ? payloads.map((p) => p.id).join(' ') : '96';

  const lines: string[] = [
    'v=0',
    'o=- 0 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    `m=${media} 9 UDP/TLS/RTP/SAVPF ${ptIds}`,
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=rtcp-mux',
    `a=ice-ufrag:${content.transport.ufrag}`,
    `a=ice-pwd:${content.transport.pwd}`,
    'a=ice-options:trickle',
  ];
  if (fingerprint) {
    lines.push(`a=fingerprint:${fingerprint.hash} ${fingerprint.value}`);
  }
  lines.push(`a=setup:${setup}`);
  lines.push('a=sendrecv');
  for (const payload of payloads) {
    const clockrate = payload.clockrate ?? (media === 'video' ? 90000 : 48000);
    let rtpmap = `a=rtpmap:${payload.id} ${payload.name}/${clockrate}`;
    if (payload.channels !== undefined) rtpmap += `/${payload.channels}`;
    lines.push(rtpmap);
  }
  return `${lines.join('\n')}\n`;
}

/** Lista los payload-types del m-line del SDP (para el eco del session-accept). */
export function rtpPayloadsFromSdp(sdp: string): RtpPayload[] {
  let pts: string[] = [];
  const rtpmaps = new Map<string, string>();
  for (const raw of sdp.split('\n')) {
    const line = raw.trim();
    const mline = /^m=(?:audio|video)\s+\d+\s+\S+\s+(.+)$/.exec(line);
    if (mline) pts = mline[1].trim().split(/\s+/);
    const rmap = /^a=rtpmap:(\d+)\s+(\S+)$/.exec(line);
    if (rmap) rtpmaps.set(rmap[1]!, rmap[2]!);
  }
  const out: RtpPayload[] = [];
  for (const pt of pts) {
    const spec = rtpmaps.get(pt);
    if (!spec) continue;
    const [name, clockrate, channels] = spec.split('/');
    const payload: RtpPayload = { id: pt, name: name! };
    const rate = Number(clockrate);
    if (Number.isInteger(rate) && rate > 0) payload.clockrate = rate;
    const ch = Number(channels);
    if (Number.isInteger(ch) && ch > 0) payload.channels = ch;
    out.push(payload);
  }
  return out;
}

export class JingleSession {
  private readonly id: string;
  private readonly peer: string;
  private readonly role: JingleRole;
  private readonly initiator: string;
  private readonly responder?: string;
  private readonly media: 'audio' | 'video';
  private readonly send: JingleSend;
  private readonly rtc: RtcBridge;
  private readonly callbacks: JingleSessionCallbacks;
  private state: SessionState = 'pending';
  private contents: JingleContent[] = [];
  private pendingOffer?: string;
  private initiated = false;
  private sentLocalCandidates: string[] = [];
  /** Los transport-info se envían sólo tras session-initiate/session-accept (XEP-0166 §7.2). */
  private signalingSent = false;
  private queuedLocalCandidates: IceCandidate[] = [];
  /** Candidatos remotos que llegan antes de setRemoteDescription: se encolan. */
  private remoteDescSet = false;
  private queuedRemoteCandidates: RtcIceCandidateInit[] = [];

  constructor(opts: JingleSessionOpts) {
    this.id = opts.id;
    this.peer = opts.peer;
    this.role = opts.role;
    this.initiator = opts.initiator;
    this.responder = opts.responder;
    this.media = opts.media;
    this.send = opts.send;
    this.rtc = opts.rtc;
    this.callbacks = opts.callbacks;
  }

  getState(): SessionState {
    return this.state;
  }

  private payloadType(): RtpPayload {
    return this.media === 'video'
      ? { id: '96', name: 'VP8', clockrate: 90000 }
      : { id: '96', name: 'opus', clockrate: 48000, channels: 2 };
  }

  private transportFromSdp(sdp: string): IceUdpTransport {
    const creds = iceCredentialsFromSdp(sdp);
    const fingerprint = fingerprintFromSdp(sdp);
    return {
      ufrag: creds.ufrag,
      pwd: creds.pwd,
      candidates: [],
      ...(fingerprint ? { fingerprint } : {}),
    };
  }

  private makeContent(transport: IceUdpTransport, payloads?: RtpPayload[]): JingleContent {
    // Payloads por defecto si el SDP no declaró ninguno (debería ser raro).
    const list =
      payloads && payloads.length > 0 ? payloads : [this.payloadType()];
    return {
      name: this.media,
      creator: this.role,
      senders: 'both',
      transport,
      rtp: { media: this.media, senders: 'both', payloads: list },
    };
  }

  private contentToElement(content: JingleContent): Element {
    // El description del echo lista TODOS los payload-types del content
    // (el offer real de libwebrtc pone varios códecs; Dino elige uno).
    const payloads = content.rtp?.payloads ?? [];
    const payloadEls = payloads.map((payload) => {
      const attrs: Record<string, string> = {
        id: payload.id,
        name: payload.name,
      };
      if (payload.clockrate !== undefined) attrs.clockrate = String(payload.clockrate);
      if (payload.channels !== undefined) attrs.channels = String(payload.channels);
      return xml('payload-type', attrs);
    });
    const description = xml(
      'description',
      { xmlns: RTP_NS, media: content.rtp?.media ?? content.name, senders: content.senders },
      ...payloadEls,
    );
    return xml(
      'content',
      { creator: content.creator, name: content.name, senders: content.senders },
      description,
      buildIceUdpTransport(content.transport),
    );
  }

  private jingle(action: JingleAction, ...children: Element[]): Element {
    const attrs: Record<string, string> = {
      xmlns: JINGLE_NS,
      action,
      sid: this.id,
      initiator: this.initiator,
    };
    if (this.responder) attrs.responder = this.responder;
    return xml('jingle', attrs, ...children);
  }

  private async sendIq(id: string, jingleEl: Element): Promise<void> {
    await this.send(xml('iq', { type: 'set', to: this.peer, id }, jingleEl));
  }

  async initiate(): Promise<void> {
    if (this.role !== 'initiator') throw new Error('Solo el iniciador puede iniciar una sesión');
    const offer = await this.rtc.createOffer();
    // Los payload-types que OFRECEMOS deben existir en el offer SDP de
    // libwebrtc: Dino/AnotherIM responden con los ids de esto y
    // setRemoteDescription(answer) exige el mismo id en el offer local.
    // Usar un '96' hardcoded rompe la reconciliación del motor.
    const payloads = rtpPayloadsFromSdp(offer.sdp);
    const content = this.makeContent(this.transportFromSdp(offer.sdp), payloads);
    this.contents = [content];
    // Los candidatos pueden empezar a llegar en cuanto setLocalDescription:
    // quedar encolados hasta haber enviado session-initiate (trickle ICE).
    await this.rtc.setLocalDescription(offer);
    this.initiated = true;
    await this.sendIq(`${this.id}-initiate`, this.jingle('session-initiate', this.contentToElement(content)));
    this.signalingSent = true;
    this.flushLocalCandidates();
  }

  /**
   * Responder: responde session-accept. Per XEP-0166 §8.2, el content se
   * ECO del session-initiate (mismo creator/creator='initiator' y name);
   * el transport es el NUESTRO y los payloads los que elijamos del offer
   * (aquí: los del answer SDP, que libwebrtc ya recortó a la oferta).
   * Reusar el content con creator='responder'/otro name hace que Dino no
   * encuentre el content y aborte la sesión.
   */
  async accept(): Promise<void> {
    if (this.role !== 'responder') throw new Error('Solo el responder puede aceptar');
    const offerContents = this.contents;
    if (!this.pendingOffer || offerContents.length === 0) throw new Error('No hay oferta para aceptar');
    await this.rtc.setRemoteDescription({ type: 'offer', sdp: this.pendingOffer });
    this.remoteDescSet = true;
    await this.flushRemoteCandidates();
    const answer = await this.rtc.createAnswer();
    await this.rtc.setLocalDescription(answer);
    const transport = this.transportFromSdp(answer.sdp);
    const payloads = rtpPayloadsFromSdp(answer.sdp);
    this.contents = offerContents.map((c) => ({
      ...c,
      transport,
      ...(c.rtp ? { rtp: { ...c.rtp, payloads: payloads.length > 0 ? payloads : c.rtp.payloads } } : {}),
    }));
    await this.sendIq(`${this.id}-accept`, this.jingle('session-accept', ...this.contents.map((c) => this.contentToElement(c))));
    this.signalingSent = true;
    this.flushLocalCandidates();
    this.state = 'active';
    this.callbacks.onStateChange('active');
  }

  async terminate(reason: JingleReason = 'success'): Promise<void> {
    if (this.state === 'ended') return;
    await this.sendIq(`${this.id}-terminate`, this.jingle('session-terminate', xml('reason', {}, xml(reason, {}))));
    this.state = 'ended';
    this.rtc.close();
    this.callbacks.onStateChange('ended');
  }

  async reject(): Promise<void> {
    await this.terminate('decline');
  }

  /** Nombre del content de esta sesión (our content name estándar). */
  private contentName(): string {
    return this.contents[0]?.name ?? this.media;
  }

  /**
   * Candidatos locales (trickle). El nombre del content es el de la sesión,
   * NO el sdpMid ('0'/'audio' es interno del motor SDP; Dino busca el content
   * por el name del session-initiate/accept). Se encola hasta que la sesión
   * fue anunciada para no adelantarnos al session-initiate/session-accept.
   */
  async sendLocalCandidates(candidates: IceCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    if (!this.signalingSent || this.state === 'ended') {
      this.queuedLocalCandidates.push(...candidates);
      return;
    }
    await this.sendTransportInfo(this.contentName(), candidates);
  }

  private flushLocalCandidates(): void {
    if (this.queuedLocalCandidates.length === 0) return;
    const queued = this.queuedLocalCandidates;
    this.queuedLocalCandidates = [];
    void this.sendTransportInfo(this.contentName(), queued).catch(() => {});
  }

  private async flushRemoteCandidates(): Promise<void> {
    const queued = this.queuedRemoteCandidates;
    this.queuedRemoteCandidates = [];
    for (const c of queued) await this.rtc.addIceCandidate(c);
  }

  async sendTransportInfo(contentName: string, candidates: IceCandidate[]): Promise<void> {
    // El creator es el CREADOR DEL CONTENT (el initiator lo creó en
    // session-initiate), no nuestro rol: Dino busca el content por
    // (creator, name) y descarta los que no matchean.
    const creator = this.contents[0]?.creator ?? this.role;
    const content = xml(
      'content',
      { creator, name: contentName },
      xml('transport', { xmlns: ICE_UDP_NS }, ...candidates.map((c) => buildCandidateElement(c))),
    );
    this.sentLocalCandidates.push(...candidates.map((c) => candidateToSdp(c)));
    await this.sendIq(`${this.id}-transport-info`, this.jingle('transport-info', content));
  }

  private parseContents(el: Element): JingleContent[] {
    const result: JingleContent[] = [];
    for (const contentEl of el.getChildren('content')) {
      const name = contentEl.attrs.name as string | undefined;
      const creator = contentEl.attrs.creator as JingleRole | undefined;
      if (!name || !creator) continue;
      const transportEl = contentEl.getChild('transport', ICE_UDP_NS);
      const transport = transportEl ? parseIceUdpTransport(transportEl) : null;
      if (!transport) continue;
      const senders = (contentEl.attrs.senders as Senders | undefined) ?? 'both';
      const descEl = contentEl.getChild('description', RTP_NS);
      let rtp: RtpDescription | undefined;
      if (descEl) {
        const media = descEl.attrs.media as 'audio' | 'video' | undefined;
        if (media === 'audio' || media === 'video') {
          const payloads: RtpPayload[] = [];
          for (const p of descEl.getChildren('payload-type')) {
            const id = p.attrs.id as string | undefined;
            const pname = p.attrs.name as string | undefined;
            if (!id || !pname) continue;
            const payload: RtpPayload = { id, name: pname };
            const clockrate = Number(p.attrs.clockrate);
            if (Number.isInteger(clockrate)) payload.clockrate = clockrate;
            const channels = Number(p.attrs.channels);
            if (Number.isInteger(channels)) payload.channels = channels;
            payloads.push(payload);
          }
          rtp = { media, senders, payloads };
          const ssrc = descEl.attrs.ssrc as string | undefined;
          if (ssrc) rtp.ssrc = ssrc;
        }
      }
      result.push({ name, creator, senders, transport, ...(rtp ? { rtp } : {}) });
    }
    return result;
  }

  private async handleSessionInitiate(el: Element): Promise<boolean> {
    if (this.role !== 'responder' || this.state !== 'pending') return false;
    const contents = this.parseContents(el);
    const first = contents[0];
    if (!first) return false;
    const sdp = sdpFromContent(first, 'offer');
    this.contents = contents;
    this.pendingOffer = sdp;
    return true;
  }

  private async handleSessionAccept(el: Element): Promise<boolean> {
    if (this.role !== 'initiator' || !this.initiated || this.state !== 'pending') return false;
    const contents = this.parseContents(el);
    const first = contents[0];
    if (!first) return false;
    this.contents = contents;
    await this.rtc.setRemoteDescription({ type: 'answer', sdp: sdpFromContent(first, 'answer') });
    this.remoteDescSet = true;
    await this.flushRemoteCandidates();
    this.state = 'active';
    this.callbacks.onStateChange('active');
    return true;
  }

  private async handleTransportInfo(el: Element): Promise<boolean> {
    let added = false;
    for (const contentEl of el.getChildren('content')) {
      const contentName = contentEl.attrs.name as string | undefined;
      if (!contentName) continue;
      const transportEl = contentEl.getChild('transport', ICE_UDP_NS);
      if (!transportEl) continue;
      for (const candEl of transportEl.getChildren('candidate')) {
        const c = parseCandidateElement(candEl);
        if (!c) continue;
        if (this.role === 'initiator' && this.sentLocalCandidates.includes(candidateToSdp(c))) continue;
        // La asociación con la m-line de libwebrtc es por índice de cuenta
        // (una sola para audio 1:1): el content name Jingle no es un a=mid.
        const init: RtcIceCandidateInit = { candidate: candidateToSdp(c), sdpMLineIndex: 0 };
        if (!this.remoteDescSet) {
          // Puede llegar transport-info antes de haber recibido el
          // session-initiate completo (raro pero legal con trickle).
          this.queuedRemoteCandidates.push(init);
        } else {
          await this.rtc.addIceCandidate(init);
        }
        added = true;
      }
    }
    return added;
  }

  async handleElement(action: JingleAction, el: Element): Promise<boolean> {
    switch (action) {
      case 'session-initiate':
        return this.handleSessionInitiate(el);
      case 'session-accept':
        return this.handleSessionAccept(el);
      case 'transport-info':
        return this.handleTransportInfo(el);
      case 'session-terminate':
        if (this.state === 'ended') return false;
        this.state = 'ended';
        this.rtc.close();
        this.callbacks.onStateChange('ended');
        return true;
      default:
        return false;
    }
  }
}

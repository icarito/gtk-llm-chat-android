import { xml } from '@xmpp/xml';
import type { Element } from '@xmpp/xml';
import { JingleSession } from '@/xmpp/jingle/session';
import type { JingleSessionCallbacks, JingleSend } from '@/xmpp/jingle/session';
import { JINGLE_NS, RTP_NS, ICE_UDP_NS, DTLS_SRTP_NS } from '@/xmpp/jingle/types';
import type { JingleRole, IceCandidate, SessionState } from '@/xmpp/jingle/types';
import type { RtcBridge, RtcIceCandidateInit, RtcSessionDescription } from '@/xmpp/jingle/rtcBridge';
import { candidateToSdp } from '@/xmpp/jingle/transport';

const OFFER_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:efgh',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 AA:BB:CC:DD',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
].join('\n') + '\n';

const ANSWER_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=ice-ufrag:wxyz',
  'a=ice-pwd:1234',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 11:22:33:44',
  'm=audio 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 opus/48000/2',
].join('\n') + '\n';

class FakeRtc implements RtcBridge {
  offerSdp = OFFER_SDP;
  answerSdp = ANSWER_SDP;
  localDesc?: RtcSessionDescription;
  remoteDesc?: RtcSessionDescription;
  candidates: RtcIceCandidateInit[] = [];
  closed = false;

  async createOffer(): Promise<RtcSessionDescription> {
    return { type: 'offer', sdp: this.offerSdp };
  }
  async createAnswer(): Promise<RtcSessionDescription> {
    return { type: 'answer', sdp: this.answerSdp };
  }
  async setLocalDescription(desc: RtcSessionDescription): Promise<void> {
    this.localDesc = desc;
  }
  async setRemoteDescription(desc: RtcSessionDescription): Promise<void> {
    this.remoteDesc = desc;
  }
  async addIceCandidate(candidate: RtcIceCandidateInit): Promise<void> {
    this.candidates.push(candidate);
  }
  close(): void {
    this.closed = true;
  }
}

const PEER = 'peer@example.com/res';
const INITIATOR = 'init@example.com/res';
const RESPONDER = 'resp@example.com/res';

function makeSession(opts: { role: JingleRole }) {
  const sent: Element[] = [];
  const states: SessionState[] = [];
  const rtc = new FakeRtc();
  const callbacks: JingleSessionCallbacks = {
    onLocalCandidate: () => {},
    onRemoteStream: () => {},
    onStateChange: (state) => {
      states.push(state);
    },
  };
  const send: JingleSend = async (el) => {
    sent.push(el);
  };
  const session = new JingleSession({
    id: 'sid1',
    peer: PEER,
    role: opts.role,
    initiator: INITIATOR,
    responder: opts.role === 'responder' ? RESPONDER : undefined,
    media: 'audio',
    send,
    rtc,
    callbacks,
  });
  return { session, sent, states, rtc };
}

function sessionInitiateElement(): Element {
  return xml(
    'jingle',
    { xmlns: JINGLE_NS, action: 'session-initiate', sid: 'sid1', initiator: INITIATOR },
    xml(
      'content',
      { creator: 'initiator', name: 'audio', senders: 'both' },
      xml(
        'description',
        { xmlns: RTP_NS, media: 'audio', senders: 'both' },
        xml('payload-type', { id: '96', name: 'opus', clockrate: '48000', channels: '2' }),
      ),
      xml(
        'transport',
        { xmlns: ICE_UDP_NS },
        xml('ice-ufrag', {}, 'abcd'),
        xml('ice-pwd', {}, 'efgh'),
        xml('fingerprint', { xmlns: DTLS_SRTP_NS, hash: 'sha-256', setup: 'actpass' }, 'AA:BB:CC:DD'),
      ),
    ),
  );
}

function sessionAcceptElement(): Element {
  return xml(
    'jingle',
    { xmlns: JINGLE_NS, action: 'session-accept', sid: 'sid1', initiator: INITIATOR, responder: RESPONDER },
    xml(
      'content',
      { creator: 'responder', name: 'audio', senders: 'both' },
      xml(
        'description',
        { xmlns: RTP_NS, media: 'audio', senders: 'both' },
        xml('payload-type', { id: '96', name: 'opus', clockrate: '48000', channels: '2' }),
      ),
      xml(
        'transport',
        { xmlns: ICE_UDP_NS },
        xml('ice-ufrag', {}, 'wxyz'),
        xml('ice-pwd', {}, '1234'),
        xml('fingerprint', { xmlns: DTLS_SRTP_NS, hash: 'sha-256', setup: 'actpass' }, '11:22:33:44'),
      ),
    ),
  );
}

const HOST_CANDIDATE: IceCandidate = {
  component: 1,
  foundation: '1',
  ip: '1.2.3.4',
  port: 50000,
  priority: 2130706431,
  protocol: 'udp',
  type: 'host',
};

function transportInfoElement(candidate: IceCandidate): Element {
  return xml(
    'jingle',
    { xmlns: JINGLE_NS, action: 'transport-info', sid: 'sid1' },
    xml(
      'content',
      { creator: 'responder', name: 'audio' },
      xml('transport', { xmlns: ICE_UDP_NS }, xml('candidate', {
        component: String(candidate.component),
        foundation: candidate.foundation,
        ip: candidate.ip,
        port: String(candidate.port),
        priority: String(candidate.priority),
        protocol: candidate.protocol,
        type: candidate.type,
      })),
    ),
  );
}

describe('JingleSession initiator', () => {
  it('inicia y envía un IQ session-initiate con el content armado', async () => {
    const { session, sent, rtc } = makeSession({ role: 'initiator' });

    await session.initiate();

    expect(sent).toHaveLength(1);
    const iq = sent[0];
    expect(iq.name).toBe('iq');
    expect(iq.attrs.type).toBe('set');
    expect(iq.attrs.to).toBe(PEER);

    const jingle = iq.getChild('jingle', JINGLE_NS)!;
    expect(jingle.attrs.action).toBe('session-initiate');
    expect(jingle.attrs.sid).toBe('sid1');
    expect(jingle.attrs.initiator).toBe(INITIATOR);

    const content = jingle.getChild('content')!;
    expect(content.attrs.creator).toBe('initiator');
    expect(content.attrs.name).toBe('audio');
    expect(content.attrs.senders).toBe('both');

    const desc = content.getChild('description', RTP_NS)!;
    expect(desc.attrs.media).toBe('audio');
    // El payload citado viene del offer SDP REAL de libwebrtc (111), no de
    // un '96' fijo: la answer del peer reproduce ESTE id y setRemote
    // Description(answer) lo valida contra el offer local.
    const pt = desc.getChild('payload-type')!;
    expect(pt.attrs).toEqual({ id: '111', name: 'opus', clockrate: '48000', channels: '2' });

    const transport = content.getChild('transport', ICE_UDP_NS)!;
    expect(transport.getChildText('ice-ufrag')).toBe('abcd');
    expect(transport.getChildText('ice-pwd')).toBe('efgh');
    const fp = transport.getChild('fingerprint', DTLS_SRTP_NS)!;
    expect(fp.attrs.hash).toBe('sha-256');
    expect(fp.text()).toBe('AA:BB:CC:DD');
    expect(transport.getChildren('candidate')).toHaveLength(0);

    expect(rtc.localDesc?.sdp).toBe(OFFER_SDP);
    expect(session.getState()).toBe('pending');
  });

  it('queda active al recibir session-accept', async () => {
    const { session, states, rtc } = makeSession({ role: 'initiator' });
    await session.initiate();

    expect(await session.handleElement('session-accept', sessionAcceptElement())).toBe(true);
    expect(rtc.remoteDesc?.type).toBe('answer');
    expect(rtc.remoteDesc?.sdp).toContain('m=audio 9 UDP/TLS/RTP/SAVPF 96');
    expect(rtc.remoteDesc?.sdp).toContain('a=ice-ufrag:wxyz');
    expect(session.getState()).toBe('active');
    expect(states).toEqual(['active']);
  });

  it('transport-info: los remotos se encolan hasta setRemote y luego se agregan', async () => {
    const { session, rtc } = makeSession({ role: 'initiator' });
    await session.initiate();

    // Trickle legítimo: los candidatos remotos suelen llegar ANTES del
    // session-accept; libwebrtc exige remote description, así que quedan
    // encolados y se aplican al setearla.
    expect(await session.handleElement('transport-info', transportInfoElement(HOST_CANDIDATE))).toBe(true);
    expect(rtc.candidates).toHaveLength(0);

    expect(await session.handleElement('session-accept', sessionAcceptElement())).toBe(true);
    expect(rtc.candidates).toHaveLength(1);
    // La asociación es por índice de m-line (audio 1:1), no por content name.
    expect(rtc.candidates[0].sdpMLineIndex).toBe(0);
    expect(rtc.candidates[0].candidate).toBe(candidateToSdp(HOST_CANDIDATE));
    expect(session.getState()).toBe('active');
  });

  it('ignora en transport-info un candidate local ya enviado', async () => {
    const { session, rtc } = makeSession({ role: 'initiator' });
    await session.initiate();
    await session.sendTransportInfo('audio', [HOST_CANDIDATE]);

    expect(await session.handleElement('transport-info', transportInfoElement(HOST_CANDIDATE))).toBe(false);
    expect(rtc.candidates).toHaveLength(0);
  });

  it('terminate envía session-terminate con razón success y cierra', async () => {
    const { session, sent, states, rtc } = makeSession({ role: 'initiator' });
    await session.initiate();

    await session.terminate();

    const jingle = sent[sent.length - 1].getChild('jingle', JINGLE_NS)!;
    expect(jingle.attrs.action).toBe('session-terminate');
    expect(jingle.getChild('reason')!.getChild('success')).toBeDefined();
    expect(session.getState()).toBe('ended');
    expect(rtc.closed).toBe(true);
    expect(states).toEqual(['ended']);
  });
});

describe('JingleSession responder', () => {
  it('handleElement(session-initiate) guarda la oferta sin setear remoteDescription todavía', async () => {
    const { session, rtc } = makeSession({ role: 'responder' });

    expect(await session.handleElement('session-initiate', sessionInitiateElement())).toBe(true);
    expect(rtc.remoteDesc).toBeUndefined();
    expect(session.getState()).toBe('pending');
  });

  it('acepta y envía session-accept con el transport de la respuesta', async () => {
    const { session, sent, states, rtc } = makeSession({ role: 'responder' });
    await session.handleElement('session-initiate', sessionInitiateElement());

    await session.accept();

    expect(rtc.remoteDesc?.type).toBe('offer');
    // El offer reconstruido debe ser consumible por libwebrtc.
    expect(rtc.remoteDesc?.sdp).toContain('a=mid:0');
    expect(rtc.remoteDesc?.sdp).toContain('a=rtcp-mux');
    expect(rtc.remoteDesc?.sdp).toContain('a=setup:actpass');
    expect(rtc.remoteDesc?.sdp).toContain('m=audio 9 UDP/TLS/RTP/SAVPF 96');
    expect(rtc.remoteDesc?.sdp).toContain('a=ice-ufrag:abcd');
    expect(rtc.remoteDesc?.sdp).toContain('a=fingerprint:sha-256 AA:BB:CC:DD');

    expect(sent).toHaveLength(1);
    const jingle = sent[0].getChild('jingle', JINGLE_NS)!;
    expect(jingle.attrs.action).toBe('session-accept');
    expect(jingle.attrs.responder).toBe(RESPONDER);

    // XEP-0166 §8.2: el content se ECO del session-initiate (creator del
    // creador original), no del rol del responder.
    const content = jingle.getChild('content')!;
    expect(content.attrs.creator).toBe('initiator');
    expect(content.attrs.name).toBe('audio');
    const payload = content.getChild('description', RTP_NS)!.getChild('payload-type')!;
    expect(payload.attrs).toEqual({ id: '96', name: 'opus', clockrate: '48000', channels: '2' });

    const transport = content.getChild('transport', ICE_UDP_NS)!;
    expect(transport.getChildText('ice-ufrag')).toBe('wxyz');
    expect(transport.getChildText('ice-pwd')).toBe('1234');
    expect(transport.getChild('fingerprint', DTLS_SRTP_NS)!.text()).toBe('11:22:33:44');

    expect(session.getState()).toBe('active');
    expect(states).toEqual(['active']);
    expect(rtc.localDesc?.sdp).toBe(ANSWER_SDP);
  });

  it('transport-info local se encola hasta que la sesión fue anunciada', async () => {
    const { session, sent, rtc } = makeSession({ role: 'initiator' });

    // Un candidato que llega entre setLocalDescription y el envío del
    // session-initiate no debe ir por delante de la señalización.
    await session.sendLocalCandidates([HOST_CANDIDATE]);
    await session.initiate();

    expect(sent).toHaveLength(2);
    expect(sent[0].getChild('jingle', JINGLE_NS)!.attrs.action).toBe('session-initiate');
    expect(sent[1].getChild('jingle', JINGLE_NS)!.attrs.action).toBe('transport-info');
    // El content del session-initiate cita el nombre del content Jingle
    // (no el sdpMid del motor), y el transport-info también.
    expect(sent[1].getChild('jingle', JINGLE_NS)!.getChild('content')!.attrs.name).toBe('audio');
    expect(rtc.localDesc?.sdp).toBe(OFFER_SDP);
  });

  it('reject envía session-terminate con decline', async () => {
    const { session, sent } = makeSession({ role: 'responder' });

    await session.reject();

    const jingle = sent[0].getChild('jingle', JINGLE_NS)!;
    expect(jingle.attrs.action).toBe('session-terminate');
    expect(jingle.getChild('reason')!.getChild('decline')).toBeDefined();
    expect(session.getState()).toBe('ended');
  });

  it('session-terminate entrante pasa a ended', async () => {
    const { session, states, rtc } = makeSession({ role: 'responder' });
    await session.handleElement('session-initiate', sessionInitiateElement());

    const terminateEl = xml('jingle', { xmlns: JINGLE_NS, action: 'session-terminate', sid: 'sid1', initiator: INITIATOR });
    expect(await session.handleElement('session-terminate', terminateEl)).toBe(true);
    expect(session.getState()).toBe('ended');
    expect(rtc.closed).toBe(true);
    expect(states).toEqual(['ended']);
  });
});

describe('JingleSession manejo de acciones', () => {
  it('devuelve false para acciones desconocidas', async () => {
    const { session } = makeSession({ role: 'initiator' });
    const el = xml('jingle', { xmlns: JINGLE_NS, action: 'session-info', sid: 'sid1' });
    expect(await session.handleElement('session-info', el)).toBe(false);
  });

  it('session-accept antes de initiate devuelve false', async () => {
    const { session } = makeSession({ role: 'initiator' });
    expect(await session.handleElement('session-accept', sessionAcceptElement())).toBe(false);
  });
});

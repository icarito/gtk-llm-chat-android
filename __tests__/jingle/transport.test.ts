import { parse } from 'ltx';
import { xml } from '@xmpp/xml';
import {
  candidateFromSdp,
  candidateToSdp,
  buildCandidateElement,
  buildIceUdpTransport,
  parseIceUdpTransport,
  iceCredentialsFromSdp,
  fingerprintFromSdp,
  mediaLineFromSdp,
} from '@/xmpp/jingle/transport';
import { ICE_UDP_NS, DTLS_SRTP_NS } from '@/xmpp/jingle/types';
import type { IceCandidate, IceUdpTransport } from '@/xmpp/jingle/types';

const hostCandidate: IceCandidate = {
  component: 1,
  foundation: '1',
  ip: '192.168.1.10',
  port: 50000,
  priority: 2130706431,
  protocol: 'udp',
  type: 'host',
};

const srflxCandidate: IceCandidate = {
  component: 1,
  foundation: '2',
  ip: '1.2.3.4',
  port: 50001,
  priority: 1694498815,
  protocol: 'udp',
  type: 'srflx',
  relAddr: '192.168.1.10',
  relPort: 50000,
};

describe('parseIceUdpTransport', () => {
  it('parsea un transport completo host + srflx con raddr y fingerprint', () => {
    const el = parse(`
      <transport xmlns="${ICE_UDP_NS}">
        <ice-ufrag>abcd</ice-ufrag>
        <ice-pwd>efgh</ice-pwd>
        <fingerprint xmlns="${DTLS_SRTP_NS}" hash="sha-256" setup="actpass">AA:BB:CC:DD</fingerprint>
        <candidate component="1" foundation="1" ip="192.168.1.10" port="50000" priority="2130706431" protocol="udp" type="host"/>
        <candidate component="1" foundation="2" ip="1.2.3.4" port="50001" priority="1694498815" protocol="udp" type="srflx" rel-addr="192.168.1.10" rel-port="50000"/>
      </transport>
    `);

    const t = parseIceUdpTransport(el);
    expect(t).not.toBeNull();
    expect(t).toEqual({
      ufrag: 'abcd',
      pwd: 'efgh',
      fingerprint: { hash: 'sha-256', value: 'AA:BB:CC:DD', setup: 'actpass' },
      candidates: [hostCandidate, srflxCandidate],
    });
  });

  it('devuelve null para un elemento que no es un transport ICE-UDP', () => {
    const wrongNs = parse(`<transport xmlns="urn:xmpp:jingle:transports:raw-udp:1"><ice-ufrag>a</ice-ufrag><ice-pwd>b</ice-pwd></transport>`);
    const wrongName = parse(`<foo xmlns="${ICE_UDP_NS}"><ice-ufrag>a</ice-ufrag><ice-pwd>b</ice-pwd></foo>`);
    expect(parseIceUdpTransport(wrongNs)).toBeNull();
    expect(parseIceUdpTransport(wrongName)).toBeNull();
  });

  it('devuelve null si faltan las credenciales ICE', () => {
    const el = parse(`<transport xmlns="${ICE_UDP_NS}"><ice-ufrag>abcd</ice-ufrag></transport>`);
    expect(parseIceUdpTransport(el)).toBeNull();
  });
});

describe('buildIceUdpTransport', () => {
  it('hace roundtrip con parseIceUdpTransport', () => {
    const t: IceUdpTransport = {
      ufrag: 'abcd',
      pwd: 'efgh',
      fingerprint: { hash: 'sha-256', value: 'AA:BB:CC:DD', setup: 'actpass' },
      candidates: [hostCandidate, srflxCandidate],
    };
    const built = buildIceUdpTransport(t);
    expect(built.attrs.xmlns).toBe(ICE_UDP_NS);
    expect(parseIceUdpTransport(built)).toEqual(t);
  });

  it('omite el fingerprint si no existe', () => {
    const built = buildIceUdpTransport({ ufrag: 'a', pwd: 'b', candidates: [] });
    expect(built.getChild('fingerprint', DTLS_SRTP_NS)).toBeUndefined();
    expect(parseIceUdpTransport(built)).toEqual({ ufrag: 'a', pwd: 'b', candidates: [] });
  });
});

describe('candidateFromSdp / candidateToSdp', () => {
  it('parsea un candidate host', () => {
    const line = 'a=candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host';
    expect(candidateFromSdp(line)).toEqual(hostCandidate);
  });

  it('parsea un candidate srflx con raddr/rport', () => {
    const line = 'a=candidate:2 1 udp 1694498815 1.2.3.4 50001 typ srflx raddr 192.168.1.10 rport 50000';
    expect(candidateFromSdp(line)).toEqual(srflxCandidate);
  });

  it('parsea un candidate relay', () => {
    const c = candidateFromSdp('a=candidate:3 1 udp 1694498815 10.0.0.5 50002 typ relay raddr 192.168.1.10 rport 50000');
    expect(c).not.toBeNull();
    expect(c!.type).toBe('relay');
    expect(c!.relAddr).toBe('192.168.1.10');
    expect(c!.relPort).toBe(50000);
  });

  it('devuelve null para una línea que no es candidate', () => {
    expect(candidateFromSdp('a=ice-ufrag:abcd')).toBeNull();
    expect(candidateFromSdp('a=candidate:1 1 udp 2130706431 192.168.1.10 50000')).toBeNull();
  });

  it('hace roundtrip', () => {
    const lines = [
      'a=candidate:1 1 udp 2130706431 192.168.1.10 50000 typ host',
      'a=candidate:2 1 udp 1694498815 1.2.3.4 50001 typ srflx raddr 192.168.1.10 rport 50000',
    ];
    for (const line of lines) {
      expect(candidateToSdp(candidateFromSdp(line)!)).toBe(line);
    }
  });

  it('buildCandidateElement produce attributes XEP-0176', () => {
    const el = buildCandidateElement(srflxCandidate);
    expect(el.attrs).toEqual({
      component: '1',
      foundation: '2',
      ip: '1.2.3.4',
      port: '50001',
      priority: '1694498815',
      protocol: 'udp',
      type: 'srflx',
      'rel-addr': '192.168.1.10',
      'rel-port': '50000',
    });
  });
});

describe('iceCredentialsFromSdp', () => {
  it('lee ufrag y pwd del SDP', () => {
    const sdp = [
      'v=0',
      'a=ice-ufrag:abcd',
      'a=ice-pwd:efgh',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    ].join('\n');
    expect(iceCredentialsFromSdp(sdp)).toEqual({ ufrag: 'abcd', pwd: 'efgh' });
  });
});

describe('fingerprintFromSdp', () => {
  it('lee la huella DTLS', () => {
    const sdp = ['v=0', 'a=fingerprint:sha-256 AA:BB:CC:DD', 'm=audio 9 UDP/TLS/RTP/SAVPF 111'].join('\n');
    expect(fingerprintFromSdp(sdp)).toEqual({ hash: 'sha-256', value: 'AA:BB:CC:DD' });
  });

  it('devuelve null si no hay huella', () => {
    expect(fingerprintFromSdp('v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\n')).toBeNull();
  });
});

describe('mediaLineFromSdp', () => {
  const audio = 'v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\n';
  const video = 'v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\n';
  const none = 'v=0\ns=-\n';

  it('detecta audio y video', () => {
    expect(mediaLineFromSdp(audio)).toBe('audio');
    expect(mediaLineFromSdp(video)).toBe('video');
  });

  it('devuelve null sin línea de media', () => {
    expect(mediaLineFromSdp(none)).toBeNull();
  });
});

describe('xml builder smoke', () => {
  it('xml de @xmpp/xml construye elementos', () => {
    const el = xml('transport', { xmlns: ICE_UDP_NS }, xml('ice-ufrag', {}, 'abcd'));
    expect(el.name).toBe('transport');
    expect(el.getChildText('ice-ufrag')).toBe('abcd');
  });
});

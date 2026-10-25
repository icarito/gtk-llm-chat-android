import { xml } from '@xmpp/xml';
import type { Element } from '@xmpp/xml';
import { ICE_UDP_NS, DTLS_SRTP_NS } from './types';
import type { IceCandidate, IceUdpTransport } from './types';

function isCandidateProtocol(protocol: string): protocol is IceCandidate['protocol'] {
  return protocol === 'udp' || protocol === 'tcp';
}

function isCandidateType(type: string): type is IceCandidate['type'] {
  return type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay';
}

export function candidateFromSdp(line: string, _ufrag?: string, _pwd?: string): IceCandidate | null {
  const m = /^a=candidate:(.+)$/.exec(line.trim());
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  const component = Number(parts[1]);
  const priority = Number(parts[3]);
  const port = Number(parts[5]);
  const protocol = parts[2];
  const type = parts[7];
  if (!Number.isInteger(component) || !Number.isInteger(priority) || !Number.isInteger(port)) return null;
  if (!isCandidateProtocol(protocol) || !isCandidateType(type)) return null;
  const candidate: IceCandidate = {
    component,
    foundation: parts[0],
    ip: parts[4],
    port,
    priority,
    protocol,
    type,
  };
  let i = 8;
  while (i + 1 < parts.length) {
    const key = parts[i];
    const value = parts[i + 1];
    if (key === 'raddr') {
      candidate.relAddr = value;
    } else if (key === 'rport') {
      const rport = Number(value);
      if (Number.isInteger(rport)) candidate.relPort = rport;
    }
    i += 2;
  }
  return candidate;
}

export function candidateToSdp(c: IceCandidate): string {
  let line = `a=candidate:${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
  if (c.relAddr !== undefined && c.relPort !== undefined) {
    line += ` raddr ${c.relAddr} rport ${c.relPort}`;
  }
  return line;
}

export function iceCredentialsFromSdp(sdp: string): { ufrag: string; pwd: string } {
  const ufrag = /^a=ice-ufrag:(.*)$/m.exec(sdp)?.[1]?.trim() ?? '';
  const pwd = /^a=ice-pwd:(.*)$/m.exec(sdp)?.[1]?.trim() ?? '';
  return { ufrag, pwd };
}

export function fingerprintFromSdp(sdp: string): { hash: string; value: string } | null {
  const m = /^a=fingerprint:(\S+)\s+(\S+)$/m.exec(sdp);
  if (!m) return null;
  return { hash: m[1], value: m[2] };
}

export function mediaLineFromSdp(sdp: string): 'audio' | 'video' | null {
  for (const raw of sdp.split('\n')) {
    const line = raw.trim();
    if (/^m=audio(\s|$)/.test(line)) return 'audio';
    if (/^m=video(\s|$)/.test(line)) return 'video';
  }
  return null;
}

export function parseCandidateElement(el: Element): IceCandidate | null {
  const component = Number(el.attrs.component);
  const priority = Number(el.attrs.priority);
  const port = Number(el.attrs.port);
  const foundation = el.attrs.foundation as string | undefined;
  const ip = el.attrs.ip as string | undefined;
  const protocol = el.attrs.protocol as string | undefined;
  const type = el.attrs.type as string | undefined;
  if (!foundation || !ip) return null;
  if (!Number.isInteger(component) || !Number.isInteger(priority) || !Number.isInteger(port)) return null;
  if (!protocol || !isCandidateProtocol(protocol)) return null;
  if (!type || !isCandidateType(type)) return null;
  const candidate: IceCandidate = { component, foundation, ip, port, priority, protocol, type };
  const relAddr = el.attrs['rel-addr'] as string | undefined;
  if (relAddr) candidate.relAddr = relAddr;
  const relPort = Number(el.attrs['rel-port']);
  if (Number.isInteger(relPort)) candidate.relPort = relPort;
  const generation = Number(el.attrs.generation);
  if (Number.isInteger(generation)) candidate.generation = generation;
  const id = el.attrs.id as string | undefined;
  if (id) candidate.id = id;
  return candidate;
}

export function buildCandidateElement(c: IceCandidate): Element {
  const attrs: Record<string, string> = {
    component: String(c.component),
    foundation: c.foundation,
    ip: c.ip,
    port: String(c.port),
    priority: String(c.priority),
    protocol: c.protocol,
    type: c.type,
  };
  if (c.generation !== undefined) attrs.generation = String(c.generation);
  if (c.id !== undefined) attrs.id = c.id;
  if (c.relAddr !== undefined) attrs['rel-addr'] = c.relAddr;
  if (c.relPort !== undefined) attrs['rel-port'] = String(c.relPort);
  return xml('candidate', attrs);
}

export function parseIceUdpTransport(el: Element): IceUdpTransport | null {
  if (el.name !== 'transport' || el.attrs.xmlns !== ICE_UDP_NS) return null;
  const ufrag = el.getChildText('ice-ufrag')?.trim();
  const pwd = el.getChildText('ice-pwd')?.trim();
  if (!ufrag || !pwd) return null;
  const candidates: IceCandidate[] = [];
  for (const candEl of el.getChildren('candidate')) {
    const candidate = parseCandidateElement(candEl);
    if (candidate) candidates.push(candidate);
  }
  const result: IceUdpTransport = { ufrag, pwd, candidates };
  const fpEl = el.getChild('fingerprint', DTLS_SRTP_NS);
  if (fpEl) {
    const hash = fpEl.attrs.hash as string | undefined;
    const value = fpEl.text().trim();
    if (hash && value) {
      const fingerprint: NonNullable<IceUdpTransport['fingerprint']> = { hash, value };
      const setup = fpEl.attrs.setup as NonNullable<IceUdpTransport['fingerprint']>['setup'] | undefined;
      if (setup) fingerprint.setup = setup;
      result.fingerprint = fingerprint;
    }
  }
  return result;
}

export function buildIceUdpTransport(t: IceUdpTransport): Element {
  const children: Element[] = [xml('ice-ufrag', {}, t.ufrag), xml('ice-pwd', {}, t.pwd)];
  if (t.fingerprint) {
    const attrs: Record<string, string> = { hash: t.fingerprint.hash };
    if (t.fingerprint.setup) attrs.setup = t.fingerprint.setup;
    children.push(xml('fingerprint', { xmlns: DTLS_SRTP_NS, ...attrs }, t.fingerprint.value));
  }
  for (const c of t.candidates) children.push(buildCandidateElement(c));
  return xml('transport', { xmlns: ICE_UDP_NS }, ...children);
}

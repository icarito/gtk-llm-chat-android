import type {
  RtcBridge,
  RtcIceCandidateInit,
  RtcSessionDescription,
} from './rtcBridge';

const WEB_UNSUPPORTED = 'Las llamadas no están disponibles en web';

export class WebrtcBridge implements RtcBridge {
  constructor() {
    throw new Error(WEB_UNSUPPORTED);
  }

  async startMedia(): Promise<void> {
    throw new Error(WEB_UNSUPPORTED);
  }

  setIceServers(
    _servers: { urls: string[]; username?: string; credential?: string }[],
  ): void {
    throw new Error(WEB_UNSUPPORTED);
  }

  createOffer(): Promise<RtcSessionDescription> {
    throw new Error(WEB_UNSUPPORTED);
  }

  createAnswer(): Promise<RtcSessionDescription> {
    throw new Error(WEB_UNSUPPORTED);
  }

  setLocalDescription(_desc: RtcSessionDescription): Promise<void> {
    throw new Error(WEB_UNSUPPORTED);
  }

  setRemoteDescription(_desc: RtcSessionDescription): Promise<void> {
    throw new Error(WEB_UNSUPPORTED);
  }

  addIceCandidate(_candidate: RtcIceCandidateInit): Promise<void> {
    throw new Error(WEB_UNSUPPORTED);
  }

  close(): void {
    throw new Error(WEB_UNSUPPORTED);
  }
}

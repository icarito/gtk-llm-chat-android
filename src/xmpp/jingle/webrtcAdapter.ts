import { PermissionsAndroid } from 'react-native';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';
import type { MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import type {
  RtcBridge,
  RtcBridgeEvents,
  RtcIceCandidateInit,
  RtcSessionDescription,
} from './rtcBridge';

type IceServers = { urls: string[]; username?: string; credential?: string }[];

interface IceCandidateEvent {
  candidate: RTCIceCandidate | null;
}

interface TrackEvent {
  streams: MediaStream[];
}

export class WebrtcBridge implements RtcBridge {
  private readonly pc: RTCPeerConnection;
  private iceServers: IceServers = [];
  private localTracks: MediaStreamTrack[] = [];
  private readonly audio: boolean;
  private readonly video: boolean;

  constructor(
    opts: { audio?: boolean; video?: boolean } = {},
    private readonly callbacks: RtcBridgeEvents,
  ) {
    this.audio = opts.audio ?? true;
    this.video = opts.video ?? false;
    this.pc = new RTCPeerConnection({ iceServers: [] });

    this.pc.onicecandidate = (event) => {
      const { candidate } = event as unknown as IceCandidateEvent;
      if (candidate) {
        this.callbacks.onLocalCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? undefined,
          sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
        });
      }
    };

    this.pc.ontrack = (event) => {
      const { streams } = event as unknown as TrackEvent;
      const stream = streams[0];
      if (stream) {
        this.callbacks.onRemoteStream(stream);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.callbacks.onClosed();
      }
    };
  }

  async startMedia(): Promise<void> {
    if (this.audio) {
      // RECORD_AUDIO es permiso RUNTIME (Android 6+): sin pedirlo, getUserMedia
      // explota y la llamada muere en conectar con una instalación recién hecha.
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Micrófono para llamadas',
          message: 'Para las llamadas de voz, la app necesita tu permiso para usar el micrófono.',
          buttonPositive: 'Permitir',
        },
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('Permiso de micrófono denegado: no se puede conectar la llamada.');
      }
    }
    const stream = await mediaDevices.getUserMedia({
      audio: this.audio,
      video: this.video,
    });
    this.localTracks = stream.getTracks();
    for (const track of this.localTracks) {
      this.pc.addTrack(track, stream);
    }
  }

  setIceServers(servers: IceServers): void {
    this.iceServers = servers;
    if (servers.length > 0) {
      this.pc.setConfiguration({ iceServers: servers });
    }
  }

  setMicrophoneMuted(muted: boolean): void {
    for (const track of this.localTracks) {
      if (track.kind === 'audio') track.enabled = !muted;
    }
  }

  async createOffer(): Promise<RtcSessionDescription> {
    this.applyIceServers();
    const offer = await this.pc.createOffer();
    return { type: 'offer', sdp: offer.sdp };
  }

  async createAnswer(): Promise<RtcSessionDescription> {
    this.applyIceServers();
    const answer = await this.pc.createAnswer();
    return { type: 'answer', sdp: answer.sdp };
  }

  async setLocalDescription(desc: RtcSessionDescription): Promise<void> {
    await this.pc.setLocalDescription(new RTCSessionDescription(desc));
  }

  async setRemoteDescription(desc: RtcSessionDescription): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
  }

  async addIceCandidate(candidate: RtcIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  close(): void {
    this.pc.close();
    for (const track of this.localTracks) {
      track.stop();
    }
    this.localTracks = [];
  }

  private applyIceServers(): void {
    if (this.iceServers.length > 0) {
      this.pc.setConfiguration({ iceServers: this.iceServers });
    }
  }
}

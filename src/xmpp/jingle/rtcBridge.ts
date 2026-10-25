/**
 * Puente abstracto entre el núcleo Jingle y el motor de medios. La
 * implementación real usa react-native-webrtc (React Native); la interfaz
 * permite testear la señalización sin dispositivo.
 */

export interface RtcSessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface RtcIceCandidateInit {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

export interface RtcBridgeEvents {
  /** Candidato local nuevo (trickle): se convierte a XEP-0176 y se envía. */
  onLocalCandidate: (candidate: RtcIceCandidateInit) => void;
  /** Stream remoto listo (para la UI de llamada). */
  onRemoteStream: (stream: unknown) => void;
  /** El peer connection se cerró. */
  onClosed: () => void;
}

/** Motor de medios mínimo para una llamada 1:1 (fase 1: audio). */
export interface RtcBridge {
  /** Crea la oferta (initiator) con el SDP local (ICE + DTLS + Opus). */
  createOffer(): Promise<RtcSessionDescription>;
  /** Crea la respuesta (responder). */
  createAnswer(): Promise<RtcSessionDescription>;
  setLocalDescription(desc: RtcSessionDescription): Promise<void>;
  setRemoteDescription(desc: RtcSessionDescription): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateInit): Promise<void>;
  close(): void;
}

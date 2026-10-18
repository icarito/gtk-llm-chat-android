import { useState, useRef, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  setAudioModeAsync,
  type AudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { RECORDING_MIME } from './audioUtils';

export type RecordingState =
  | 'idle'
  | 'holding'
  | 'locked'
  | 'cancelling'
  | 'captured'
  | 'uploading'
  | 'failed';

export interface VoiceCapture {
  fileUri: string;
  duration: number;
  mimeType: string;
}

const recordingOptions: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 128000,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    sampleRate: 44100,
  },
  ios: {
    extension: '.m4a',
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    sampleRate: 44100,
  },
  web: {},
};

export function useVoiceRecorder() {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [capture, setCapture] = useState<VoiceCapture | null>(null);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  // Único estado en vivo que le hacía falta a la UI: antes la duración solo
  // se calculaba una vez, al soltar, así que no había manera de mostrar un
  // contador que creciera mientras se graba.
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingRef = useRef<AudioRecorder | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (recordingState !== 'holding' && recordingState !== 'locked') return;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 200);
    return () => clearInterval(id);
  }, [recordingState]);

  const requestPermission = useCallback(async () => {
    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    if (!granted) {
      Alert.alert(
        'Permiso denegado',
        'Se necesita acceso al micrófono para grabar mensajes de voz.',
      );
      return false;
    }
    return true;
  }, []);

  const startRecording = useCallback(async () => {
    if (!(await requestPermission())) return;
    try {
      // stopRecording deja allowsRecordingIOS en false al terminar (para no
      // acaparar el micrófono entre grabaciones). Sin re-habilitarlo aquí,
      // solo la primera grabación de la vida del componente funcionaba: las
      // siguientes creaban el AudioRecorder igual, pero con el modo de
      // audio equivocado — en Android eso produce una grabación vacía o
      // directamente inútil sin ningún error visible.
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
      });
      const recording = new AudioModule.AudioRecorder(recordingOptions);
      await recording.prepareToRecordAsync();
      recording.record();
      recordingRef.current = recording;
      startTimeRef.current = Date.now();
      setElapsedMs(0);
      setRecordingState('holding');
      setRecorderError(null);
    } catch (e) {
      setRecorderError(e instanceof Error ? e.message : String(e));
      setRecordingState('failed');
    }
  }, [requestPermission]);

  const stopRecording = useCallback(async (discard = false) => {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    try {
      await rec.stop();
    } catch {
      // ignore
    }
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    }).catch(() => {});
    const duration = (Date.now() - startTimeRef.current) / 1000;
    const uri = rec.uri;
    if (discard || !uri || duration < 3) {
      setRecordingState('idle');
      setCapture(null);
      if (duration < 3 && !discard && uri) {
        Alert.alert(
          'Demasiado corto',
          'La grabación debe durar al menos 3 segundos.',
        );
      }
      return;
    }
    const cap: VoiceCapture = {
      fileUri: uri,
      duration: Math.max(0.1, duration),
      mimeType: RECORDING_MIME,
    };
    setCapture(cap);
    setRecordingState('captured');
    return cap;
  }, []);

  const setUploading = useCallback(() => {
    setRecordingState('uploading');
  }, []);

  const setFailed = useCallback((error?: string) => {
    setRecorderError(error ?? null);
    setRecordingState('failed');
  }, []);

  const reset = useCallback(() => {
    recordingRef.current = null;
    setRecordingState('idle');
    setCapture(null);
    setRecorderError(null);
    setElapsedMs(0);
  }, []);

  const setLocked = useCallback(() => {
    if (recordingState === 'holding') {
      setRecordingState('locked');
    }
  }, [recordingState]);

  return {
    recordingState,
    capture,
    recorderError,
    elapsedMs,
    startRecording,
    stopRecording,
    setUploading,
    setFailed,
    reset,
    setLocked,
  };
}

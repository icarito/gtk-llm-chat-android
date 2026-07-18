import { useState, useRef, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
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

const recordingOptions = {
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
  },
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  web: {},
};

export function useVoiceRecorder() {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [capture, setCapture] = useState<VoiceCapture | null>(null);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const startTimeRef = useRef<number>(0);

  const requestPermission = useCallback(async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      Alert.alert(
        'Permiso denegado',
        'Se necesita acceso al micrófono para grabar mensajes de voz.',
      );
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    }).catch(() => {});
  }, []);

  const startRecording = useCallback(async () => {
    if (!(await requestPermission())) return;
    try {
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(recordingOptions);
      await recording.startAsync();
      recordingRef.current = recording;
      startTimeRef.current = Date.now();
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
      await rec.stopAndUnloadAsync();
    } catch {
      // ignore
    }
    const duration = (Date.now() - startTimeRef.current) / 1000;
    const uri = rec.getURI();
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
    startRecording,
    stopRecording,
    setUploading,
    setFailed,
    reset,
    setLocked,
  };
}

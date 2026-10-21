import { useState, useRef, useEffect, useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { Colors } from '@/constants/theme';
import type { ChatMessage } from './toIMessage';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function AudioBubble({ url, duration }: { url: string; duration?: number | null }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [soundDuration, setSoundDuration] = useState(duration ?? 0);
  const soundRef = useRef<AudioPlayer | null>(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.remove();
        soundRef.current = null;
      }
    };
  }, []);

  const handleToggle = useCallback(async () => {
    if (loading || error) return;

    if (playing && soundRef.current) {
      soundRef.current.pause();
      setPlaying(false);
      return;
    }

    if (soundRef.current) {
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        });
        soundRef.current.play();
        setPlaying(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    setLoading(true);
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      const newSound = createAudioPlayer({ uri: url }, { updateInterval: 200 });
      newSound.addListener('playbackStatusUpdate', (status) => {
        if (!status.isLoaded) return;
        if (status.didJustFinish) {
          setPlaying(false);
          setPosition(0);
        } else if (status.playing) {
          setPosition(status.currentTime);
          if (status.duration && !duration) {
            setSoundDuration(status.duration);
          }
        }
      });
      newSound.play();
      soundRef.current = newSound;
      setPlaying(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [url, playing, loading, error, duration]);

  const icon = error ? 'alert-circle' : playing ? 'pause' : 'play';
  const color = error ? Colors.error : Colors.primary;
  const durationLabel = soundDuration > 0
    ? ` / ${formatDuration(soundDuration)}`
    : '';
  const posLabel = playing ? formatDuration(position) : '';

  return (
    <TouchableOpacity style={styles.audioBubble} onPress={handleToggle}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.audioLabel, error && { color: Colors.error }]}>
        {error ? error : playing ? `${posLabel}${durationLabel}` : `Voz${durationLabel}`}
      </Text>
    </TouchableOpacity>
  );
}

/** Nota de voz / audio adjunto dentro de la burbuja. */
export function AudioBubbleForMessage({ message }: { message: ChatMessage }) {
  return <AudioBubble url={message.audio ?? ''} duration={message.duration} />;
}

const styles = StyleSheet.create({
  audioBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  audioLabel: { color: Colors.primary, fontSize: 14 },
});

export const RECORDING_MIME = 'audio/mp4';
export const RECORDING_EXT = '.m4a';

const PLAYBACK_MIMES = new Set([
  'audio/mp4',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
]);

const AUDIO_EXT_PATTERN = /\.(ogg|oga|opus|m4a|mp3|wav)(\?|#|$)/i;

export function isAudioMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return PLAYBACK_MIMES.has(mimeType.toLowerCase().split(';')[0].trim());
}

export function isAudioUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return AUDIO_EXT_PATTERN.test(url);
}

export function isPlayableMime(mimeType: string | null | undefined): boolean {
  return isAudioMime(mimeType);
}

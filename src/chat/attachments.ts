import { isAudioUrl } from '@/xmpp/audioUtils';

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)(\?|#|$)/i;
const TRAILING_URL_PUNCT_RE = /[.,;:!?)\]}]+$/;

export function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
}

function urlsIn(content: string): { url: string; index: number; length: number }[] {
  const found: { url: string; index: number; length: number }[] = [];
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(content)) !== null) {
    found.push({
      url: match[0].replace(TRAILING_URL_PUNCT_RE, ''),
      index: match.index,
      length: match[0].length,
    });
  }
  return found;
}

/** Quita del cuerpo el link del adjunto (suele repetir la URL o una etiqueta genérica). */
function stripUrl(content: string, url: string): string {
  const hit = urlsIn(content).find((u) => u.url === url);
  if (!hit) return content;
  const stripped = `${content.slice(0, hit.index)}${content.slice(hit.index + hit.length)}`
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/\s+[)\]}]+(?=\s|$)/g, '')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped.replace(/^\[Photo\]\s*[^:\n]*:\s*$/i, '').trim();
}

export interface Attachment {
  kind: 'image' | 'audio' | 'file';
  url: string;
  /** Cuerpo sin el link del adjunto. */
  text: string;
}

/**
 * Clasifica el adjunto de un mensaje (XEP-0363 vía OOB, o un link suelto en el
 * cuerpo) y devuelve el texto restante. `null` si no hay adjunto.
 */
export function parseAttachment(
  body: string,
  oobUrl?: string | null,
  localUri?: string | null,
): Attachment | null {
  // XEP-0454: la URL aesgcm:// lleva la clave en el fragmento; nunca se muestra.
  if (body.startsWith('aesgcm://')) {
    const path = body.split('#')[0];
    if (!localUri) return { kind: 'file', url: '', text: 'Adjunto cifrado (no disponible)' };
    return { kind: isAudioUrl(path) ? 'audio' : isImageUrl(path) ? 'image' : 'file', url: localUri, text: '' };
  }
  const url = oobUrl || urlsIn(body).find((u) => isImageUrl(u.url))?.url
    || (isAudioUrl(body) ? urlsIn(body)[0]?.url : undefined);
  if (!url) return null;
  const text = stripUrl(body, url);
  return { kind: isAudioUrl(url) ? 'audio' : isImageUrl(url) ? 'image' : 'file', url, text };
}

/** Nombre de archivo legible a partir del link del adjunto. */
export function fileNameFromUrl(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || url;
  } catch {
    return url.split('/').pop() || url;
  }
}

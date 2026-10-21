import type { Picked } from './attachPicker';

/**
 * Variante web del selector de adjuntos. En react-native-web `Alert.alert`
 * no soporta botones/acciones personalizadas (y mucho menos en el webview de
 * Tauri), así que se usa un <input type="file"> DOM real. El resultado es un
 * Picked con `uri` blob: (fetchable por upload para XMPP).
 */

const SAFETY_TIMEOUT_MS = 180_000;

function pickFromInput(accept: string): Promise<Picked | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;

    // Red de seguridad: si el webview no devuelve foco al cancelar, no dejar
    // la promesa colgada para siempre (bloquearía el botón).
    const safety = setTimeout(() => {
      if (!settled) settle(null);
    }, SAFETY_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(safety);
      input.remove();
      window.removeEventListener('focus', onFocus);
    }

    function settle(value: Picked | null) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function onFocus() {
      // El navegador devuelve el foco al cancelar el selector sin archivo.
      setTimeout(() => {
        if (input.files?.length === 0) settle(null);
      }, 300);
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { settle(null); return; }
      settle({
        uri: URL.createObjectURL(file),
        name: file.name || 'adjunto',
        mime: file.type || 'application/octet-stream',
      });
    }, { once: true });
    window.addEventListener('focus', onFocus, { once: true });

    input.click();
  });
}

export async function chooseAttachment(): Promise<Picked | null> {
  return pickFromInput('image/*,*/*');
}

export async function pickPhoto(): Promise<Picked | null> {
  return pickFromInput('image/*');
}

export async function pickFile(): Promise<Picked | null> {
  return pickFromInput('*/*');
}

const AVATAR_SIZE = 256;

/**
 * Foto de perfil para la variante web: mismo contrato que la nativa
 * (attachPicker.ts) — recorte cuadrado (cover) y PNG 256x256 en base64 — pero
 * con un <input type="file"> DOM real y un <canvas> para el recorte, ya que
 * expo-image-picker no existe en el webview de Tauri.
 */
export async function pickAvatarImage(_source: 'camera' | 'gallery'): Promise<{
  base64: string;
  mime: string;
  width: number;
  height: number;
} | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;

  const img = await pickFromInput('image/*');
  if (!img) return null;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const side = Math.min(image.width, image.height);
        const sx = (image.width - side) / 2;
        const sy = (image.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        const dataUrl = canvas.toDataURL('image/png');
        resolve({
          base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
          mime: 'image/png',
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
        });
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = img.uri;
  });
}

/**
 * Zoom de escritorio para el webview de Tauri: Ctrl+rueda y Ctrl+'+'/'-'
 * agrandan/reducen la tipografía aplicando la propiedad CSS `zoom` sobre el
 * elemento raíz (#root), igual que el zoom de un navegador. WebKitGTK (Tauri
 * en Linux), WKWebView y WebView2 soportan `zoom`. Se aplica en la raíz del
 * documento, así que escala fuentes y disposición proporcionalmente.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';

const MIN_ZOOM = 0.8;
const MAX_ZOOM = 2.0;
const STEP = 0.1;
const STORAGE_KEY = 'desktop.zoom';

function readStored(): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? clamp(value) : 1;
  } catch {
    return 1;
  }
}

function clamp(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function apply(zoom: number) {
  const root = document.getElementById('root');
  if (root) root.style.zoom = String(zoom);
  try { globalThis.localStorage?.setItem(STORAGE_KEY, String(zoom)); } catch { /* noop */ }
}

export function useDesktopZoom(): void {
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    let zoom = readStored();
    apply(zoom);

    const setZoom = (next: number) => {
      zoom = clamp(Math.round(next / STEP) * STEP);
      apply(zoom);
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? STEP : -STEP));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom + STEP); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom - STEP); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
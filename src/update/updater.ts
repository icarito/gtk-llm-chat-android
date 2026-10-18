import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

// Actualizaciones in-app desde GitHub Releases (como xat). Solo Android:
// en iOS las builds llegan por TestFlight.

const API_LATEST = 'https://api.github.com/repos/icarito/gtk-llm-chat-android/releases/latest';
const CHECK_INTERVAL_MS = 12 * 3600 * 1000;

export interface UpdateInfo {
  version: string;
  tag: string;
  notes: string;
  url: string;
  size: number;
  name: string;
}

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'uptodate' | 'error';

export interface UpdateSnapshot {
  state: UpdateState;
  info: UpdateInfo | null;
  progress: number; // 0..1
  error: string | null;
  path: string | null;
}

interface Release {
  tag_name?: string;
  body?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}

/** Parte "1.2.3-rc4" en núcleo numérico y prerelease (null = release final). */
function parse(v: string): { core: number[]; pre: string | null } {
  const [core, ...rest] = v.trim().replace(/^v/i, '').split('-');
  return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: rest.length ? rest.join('-') : null };
}

function comparePre(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d) return d;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** true si `a` es estrictamente más nueva que `b` (0.2.0-rc3 < 0.2.0; rc2 < rc3). */
export function isNewer(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return comparePre(x.pre, y.pre) > 0;
}

export function pickApkAsset(release: Release) {
  return (release.assets ?? []).find((a) => a.name?.toLowerCase().endsWith('.apk') && a.browser_download_url);
}

/** Solo https en github.com / objects.githubusercontent.com. */
export function isTrustedUrl(url: string): boolean {
  const m = /^https:\/\/([^/:?#]+)(?::443)?\//.exec(url);
  return !!m && (m[1] === 'github.com' || m[1] === 'objects.githubusercontent.com');
}

export function currentVersion(): string {
  return Application.nativeApplicationVersion ?? '0.0.0';
}

/** Devuelve la actualización disponible o null si ya está al día; lanza con mensaje legible. */
export async function checkForUpdate(current: string): Promise<UpdateInfo | null> {
  let res: Response;
  try {
    res = await fetch(API_LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'exit-x-chat-updater' },
    });
  } catch {
    throw new Error('Sin conexión: no se pudo consultar las actualizaciones');
  }
  if (res.status === 404) throw new Error('Aún no hay versiones publicadas');
  if (!res.ok) throw new Error(`GitHub respondió HTTP ${res.status}`);
  const release = (await res.json()) as Release;
  const tag = release.tag_name ?? '';
  const version = tag.replace(/^v/i, '');
  if (!version) throw new Error('Respuesta de GitHub sin versión');
  if (!isNewer(version, current)) return null;
  const asset = pickApkAsset(release);
  if (!asset) throw new Error(`La versión ${version} no incluye un APK`);
  return {
    version,
    tag,
    notes: release.body ?? '',
    url: asset.browser_download_url as string,
    size: asset.size ?? 0,
    name: asset.name as string,
  };
}

export async function downloadUpdate(info: UpdateInfo, onProgress: (p: number) => void): Promise<string> {
  if (!isTrustedUrl(info.url)) throw new Error('URL de descarga no confiable');
  const dir = `${FileSystem.cacheDirectory}updates/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const dest = dir + info.name.replace(/[^\w.-]/g, '_');
  const dl = FileSystem.createDownloadResumable(info.url, dest, {}, (p) => {
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : info.size;
    if (total > 0) onProgress(Math.min(1, p.totalBytesWritten / total));
  });
  const r = await dl.downloadAsync();
  if (!r || r.status !== 200) throw new Error(`Descarga fallida (HTTP ${r?.status ?? '?'})`);
  return r.uri;
}

export async function installApk(path: string): Promise<void> {
  const data = await FileSystem.getContentUriAsync(path);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}

// --- store ---

let snap: UpdateSnapshot = { state: 'idle', info: null, progress: 0, error: null, path: null };
let lastCheck = 0;
let bannerDismissed = false;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateSnapshot>): void {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const updatesSupported = Platform.OS === 'android';

export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

export function useUpdateBanner(): { info: UpdateInfo | null; dismiss: () => void } {
  const s = useUpdate();
  const dismissed = useSyncExternalStore(subscribe, () => bannerDismissed);
  const show = updatesSupported && !dismissed && (s.state === 'available' || s.state === 'downloaded');
  return { info: show ? s.info : null, dismiss: () => { bannerDismissed = true; listeners.forEach((l) => l()); } };
}

export async function runCheck(): Promise<void> {
  if (!updatesSupported || snap.state === 'checking' || snap.state === 'downloading') return;
  lastCheck = Date.now();
  set({ state: 'checking', error: null });
  try {
    const info = await checkForUpdate(currentVersion());
    bannerDismissed = false;
    set(info ? { state: 'available', info, progress: 0 } : { state: 'uptodate', info: null });
  } catch (e) {
    set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

/** Chequeo automático: como mucho cada 12 h. */
export function maybeCheck(): void {
  if (Date.now() - lastCheck >= CHECK_INTERVAL_MS) void runCheck();
}

export async function startDownload(): Promise<void> {
  const info = snap.info;
  if (!info || snap.state === 'downloading') return;
  set({ state: 'downloading', progress: 0, error: null });
  try {
    const path = await downloadUpdate(info, (progress) => set({ progress }));
    set({ state: 'downloaded', path, progress: 1 });
  } catch (e) {
    set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

export async function startInstall(): Promise<void> {
  if (!snap.path) return;
  try {
    await installApk(snap.path);
  } catch (e) {
    set({ state: 'error', error: `No se pudo abrir el instalador: ${e instanceof Error ? e.message : String(e)}` });
  }
}

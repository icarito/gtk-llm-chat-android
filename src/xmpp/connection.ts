/**
 * Máquina de estados de la conexión + política ÚNICA de reconexión.
 *
 * Antes había tres mecanismos solapados (@xmpp/reconnect con 5s fijos, un
 * scheduleReconnect propio y el watchdog de ping). Ahora @xmpp/reconnect está
 * desactivado y todo disparador (socket caído, error, ping muerto, fallo de
 * connect) desemboca en `scheduleReconnect()`: backoff 5s, 10s, … tope 2min,
 * que se resetea al llegar a ONLINE y se detiene si la autenticación falla.
 *
 * Modelo de estados tomado del cliente Godot (xat, session.gd).
 */
import type { XmppConnectionState } from '@/types/xmpp';

export type ConnState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'SYNCING'
  | 'ONLINE'
  | 'RECONNECTING'
  | 'AUTH_FAILED';

/** Fases observables del arranque (futuro checklist de inicio en la UI). */
export type StartupStep = 'tls' | 'sasl' | 'roster' | 'mam';
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export type Startup = Record<StartupStep, StepStatus>;

/** Por qué estamos en RECONNECTING: 'error' conserva el estado legacy 'error' de la UI. */
export type ReconnectCause = 'drop' | 'error';

/** Backoff: 5s, 10s, 20s, 40s, 80s, tope 2min. */
export const RETRY_BASE_MS = 5000;
export const RETRY_MAX_MS = 120000;

const freshStartup = (): Startup => ({ tls: 'pending', sasl: 'pending', roster: 'pending', mam: 'pending' });

export interface ConnectionOptions {
  /** Un intento de reconexión; debe resolver cuando termine (no necesariamente en ONLINE). */
  attempt: () => Promise<void>;
  /** false = no hay cuenta a la que reconectar. */
  hasAccount: () => boolean;
  baseMs?: number;
  maxMs?: number;
}

export class Connection {
  private _state: ConnState = 'DISCONNECTED';
  private _cause: ReconnectCause = 'drop';
  private _startup: Startup = freshStartup();
  private listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /** true tras un disconnect() explícito: no reconectar a espaldas del usuario. */
  private userStopped = false;

  constructor(private readonly opts: ConnectionOptions) {}

  get state(): ConnState { return this._state; }
  get startup(): Startup { return this._startup; }
  get attempts(): number { return this.retryAttempt; }
  get hasPendingRetry(): boolean { return this.retryTimer !== null; }

  /** SYNCING cuenta como utilizable: el stream ya está arriba (equivale al antiguo 'online'). */
  isUsable(): boolean {
    return this._state === 'SYNCING' || this._state === 'ONLINE';
  }

  /** Estado que consume la UI actual (no cambia su vocabulario). */
  legacyState(): XmppConnectionState {
    switch (this._state) {
      case 'DISCONNECTED': return 'disconnected';
      case 'CONNECTING': return 'connecting';
      case 'SYNCING':
      case 'ONLINE': return 'online';
      case 'RECONNECTING': return this._cause === 'error' ? 'error' : 'offline';
      case 'AUTH_FAILED': return 'error';
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  set(state: ConnState, cause: ReconnectCause = 'drop') {
    if (state === this._state && cause === this._cause) return;
    this._state = state;
    this._cause = cause;
    if (state === 'CONNECTING') this._startup = freshStartup();
    // Sólo se resetea el backoff al quedar en línea de verdad (la sesión ya
    // está arriba: SYNCING/ONLINE), nunca por un simple "conectando".
    if (state === 'SYNCING' || state === 'ONLINE') this.resetBackoff();
    if (state === 'AUTH_FAILED') this.resetBackoff();
    this.emit();
  }

  step(step: StartupStep, status: StepStatus) {
    if (this._startup[step] === status) return;
    this._startup = { ...this._startup, [step]: status };
    this.emit();
  }

  /** Cancela el reintento pendiente sin tocar el contador (un connect en curso ya lo reemplaza). */
  cancelPendingRetry() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  resetBackoff() {
    this.cancelPendingRetry();
    this.retryAttempt = 0;
  }

  /** disconnect() explícito: apaga el backoff y bloquea reintentos hasta resume(). */
  halt() {
    this.userStopped = true;
    this.resetBackoff();
  }

  /** connect() explícito: conectar es la intención contraria y reabre la puerta al reintento. */
  resume() {
    this.userStopped = false;
  }

  /**
   * Única entrada para recuperar la sesión tras una caída. Idempotente mientras
   * haya un reintento pendiente; no hace nada tras un disconnect del usuario ni
   * tras un fallo de autenticación (reintentar con credenciales malas sólo
   * martilla al servidor).
   */
  scheduleReconnect() {
    if (this.userStopped || this.retryTimer || !this.opts.hasAccount()) return;
    if (this._state === 'AUTH_FAILED') return;
    const base = this.opts.baseMs ?? RETRY_BASE_MS;
    const max = this.opts.maxMs ?? RETRY_MAX_MS;
    const delay = Math.min(base * 2 ** this.retryAttempt, max);
    this.retryAttempt++;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.userStopped || !this.opts.hasAccount() || this._state === 'AUTH_FAILED') return;
      if (this.isUsable()) { this.resetBackoff(); return; }
      try {
        await this.opts.attempt();
        // El intento puede devolver mientras un handshake compartido sigue en
        // CONNECTING: eso no es recuperación y no debe cancelar el watchdog.
        if (this.isUsable()) this.resetBackoff();
        else this.scheduleReconnect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }
}

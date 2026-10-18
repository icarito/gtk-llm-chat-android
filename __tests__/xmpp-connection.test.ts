import { Connection, RETRY_BASE_MS, RETRY_MAX_MS } from '@/xmpp/connection';

function make(attempt: jest.Mock = jest.fn().mockRejectedValue(new Error('down'))) {
  const conn = new Connection({ attempt, hasAccount: () => true });
  return { conn, attempt };
}

describe('Connection state machine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('maps the new states onto the legacy vocabulary the UI consumes', () => {
    const { conn } = make();
    expect(conn.legacyState()).toBe('disconnected');
    conn.set('CONNECTING');
    expect(conn.legacyState()).toBe('connecting');
    conn.set('SYNCING');
    expect(conn.legacyState()).toBe('online');
    conn.set('ONLINE');
    expect(conn.legacyState()).toBe('online');
    conn.set('RECONNECTING', 'drop');
    expect(conn.legacyState()).toBe('offline');
    conn.set('RECONNECTING', 'error');
    expect(conn.legacyState()).toBe('error');
    conn.set('AUTH_FAILED');
    expect(conn.legacyState()).toBe('error');
  });

  it('treats SYNCING and ONLINE as usable, nothing else', () => {
    const { conn } = make();
    for (const s of ['DISCONNECTED', 'CONNECTING', 'RECONNECTING', 'AUTH_FAILED'] as const) {
      conn.set(s);
      expect(conn.isUsable()).toBe(false);
    }
    conn.set('SYNCING');
    expect(conn.isUsable()).toBe(true);
    conn.set('ONLINE');
    expect(conn.isUsable()).toBe(true);
  });

  it('tracks startup steps and resets them on CONNECTING', () => {
    const { conn } = make();
    const seen = jest.fn();
    conn.subscribe(seen);
    conn.set('CONNECTING');
    conn.step('tls', 'done');
    conn.step('sasl', 'active');
    expect(conn.startup).toEqual({ tls: 'done', sasl: 'active', roster: 'pending', mam: 'pending' });
    conn.step('sasl', 'active'); // idempotente: no notifica
    const calls = seen.mock.calls.length;
    conn.step('sasl', 'active');
    expect(seen.mock.calls.length).toBe(calls);
    conn.set('CONNECTING', 'error');
    expect(conn.startup.tls).toBe('pending');
  });

  it('backs off 5s, 10s, 20s ... capped at 2min while attempts keep failing', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'drop');
    const delays: number[] = [];
    let expected = RETRY_BASE_MS;
    for (let i = 0; i < 8; i++) {
      conn.scheduleReconnect();
      delays.push(Math.min(expected, RETRY_MAX_MS));
      const before = attempt.mock.calls.length;
      await jest.advanceTimersByTimeAsync(Math.min(expected, RETRY_MAX_MS) - 1);
      expect(attempt.mock.calls.length).toBe(before); // aún no
      await jest.advanceTimersByTimeAsync(1);
      expect(attempt.mock.calls.length).toBe(before + 1);
      expected *= 2;
    }
    expect(delays).toEqual([5000, 10000, 20000, 40000, 80000, 120000, 120000, 120000]);
  });

  it('re-schedules by itself after a failed attempt (one policy, no extra triggers needed)', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(conn.hasPendingRetry).toBe(true);
    await jest.advanceTimersByTimeAsync(10000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('is idempotent while a retry is pending (ping, error and disconnect may all fire)', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    conn.scheduleReconnect();
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('resets the backoff when the session comes up (SYNCING/ONLINE)', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(5000);
    expect(conn.attempts).toBeGreaterThan(0);
    conn.set('SYNCING');
    expect(conn.attempts).toBe(0);
    expect(conn.hasPendingRetry).toBe(false);
    attempt.mockClear();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(1); // vuelve a empezar en 5s
  });

  it('does not reset the backoff on a mere CONNECTING (attempt in flight)', () => {
    const { conn } = make();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    conn.set('CONNECTING');
    expect(conn.hasPendingRetry).toBe(true);
    expect(conn.attempts).toBe(1);
  });

  it('stops on auth failure and refuses to schedule', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'error');
    conn.scheduleReconnect();
    conn.set('AUTH_FAILED');
    expect(conn.hasPendingRetry).toBe(false);
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('does not reconnect behind the user\'s back after halt(), until resume()', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    conn.halt();
    expect(conn.hasPendingRetry).toBe(false);
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(attempt).not.toHaveBeenCalled();
    conn.resume();
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('a coalesced attempt that returns while still CONNECTING keeps the watchdog alive', async () => {
    const attempt = jest.fn().mockResolvedValue(undefined); // vuelve sin quedar online
    const { conn } = make(attempt);
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    await jest.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(conn.hasPendingRetry).toBe(true);
  });

  it('skips the attempt if the session recovered while the timer was pending', async () => {
    const { conn, attempt } = make();
    conn.set('RECONNECTING', 'drop');
    conn.scheduleReconnect();
    // Recupera por otra vía (AppState): set() ya limpia el timer, pero aun
    // si el timer sobreviviera, el callback no debe intentar de nuevo.
    conn.set('ONLINE');
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(attempt).not.toHaveBeenCalled();
  });
});

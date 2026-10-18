/**
 * Facade-level check of the unified reconnect policy with a mocked @xmpp/client:
 * a dropped socket, a dead connect and an auth failure all go through the single
 * backoff in connection.ts (and @xmpp/reconnect is switched off).
 */
import { EventEmitter } from 'eventemitter3';

const mockClients: MockClient[] = [];
let mockStart: 'online' | 'hang' | 'auth-fail' | 'fail' = 'online';

class MockClient extends EventEmitter {
  streamManagement: Record<string, unknown> = { id: '', inbound: 0, outbound: 0 };
  reconnect = { stop: jest.fn() };
  iqCaller = { request: jest.fn().mockResolvedValue({ getChild: () => undefined }) };
  send = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue(undefined);
  start = jest.fn(async () => {
    if (mockStart === 'hang') return new Promise<void>(() => {});
    if (mockStart === 'fail') throw new Error('ECONNREFUSED');
    if (mockStart === 'auth-fail') {
      const err = new Error('not-authorized');
      err.name = 'SASLError';
      throw err;
    }
    this.emit('status', 'connect');
    this.emit('online');
  });
}

jest.mock('@xmpp/client', () => ({
  client: jest.fn(() => {
    const c = new MockClient();
    mockClients.push(c);
    return c;
  }),
  xml: jest.fn((name: string) => ({ name })),
}));
jest.mock('expo-file-system', () => ({}));
jest.mock('@/xmpp/notifications', () => ({
  dismissNotificationForJid: jest.fn().mockResolvedValue(undefined),
  getStoredExpoPushToken: jest.fn().mockResolvedValue(null),
  isNotificationGraceActive: jest.fn(() => false),
  notifyXmppMessage: jest.fn(),
  setConnected: jest.fn(),
  updateContactNameCache: jest.fn(),
}));
jest.mock('@/xmpp/shortcuts', () => ({ updateContactShortcuts: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/xmpp/deviceResource', () => ({ getDeviceResourceSuffix: jest.fn().mockResolvedValue('dev') }));
jest.mock('@/xmpp/ForegroundService', () => ({
  ForegroundService: { start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/xmpp/xep-0384', () => ({
  Omemo: {
    isEnabled: () => false,
    init: jest.fn().mockResolvedValue(undefined),
    removeOwnDevice: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@/xmpp/XmppHistory', () => ({ XmppHistory: {} }));

import { XmppService } from '@/xmpp/XmppService';

const config = { jid: 'me@example.org', password: 'pw', service: 'wss://example.org/ws', resource: 'app', omemoEnabled: false };

async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}

describe('unified reconnect policy (facade)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    mockClients.length = 0;
    mockStart = 'online';
  });
  afterEach(async () => {
    await XmppService.disconnect();
    jest.useRealTimers();
  });

  it('disables @xmpp/reconnect and walks tls/sasl/roster to ONLINE', async () => {
    await XmppService.connect(config);
    await flush();
    expect(mockClients).toHaveLength(1);
    expect(mockClients[0]!.reconnect.stop).toHaveBeenCalled();
    expect(XmppService.getState()).toBe('online');
    expect(XmppService.connection.startup.tls).toBe('done');
    expect(XmppService.connection.startup.sasl).toBe('done');
    expect(XmppService.connection.state).toBe('ONLINE');
    expect(XmppService.connection.startup.roster).toBe('done');
    expect(XmppService.connection.startup.mam).toBe('skipped');
  });

  it('a socket drop enters RECONNECTING and retries with a NEW client after 5s', async () => {
    await XmppService.connect(config);
    await flush();
    mockClients[0]!.emit('disconnect', { clean: false });
    expect(XmppService.connection.state).toBe('RECONNECTING');
    expect(XmppService.getState()).toBe('offline');
    expect(mockClients).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(4999);
    expect(mockClients).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(mockClients).toHaveLength(2);
    expect(XmppService.connection.state).toBe('ONLINE');
  });

  it('keeps backing off (5s then 10s) while connects fail, then recovers and resets', async () => {
    await XmppService.connect(config);
    await flush();
    mockStart = 'fail';
    mockClients[0]!.emit('disconnect', { clean: false });
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockClients).toHaveLength(2);
    expect(XmppService.connection.state).toBe('RECONNECTING');
    await jest.advanceTimersByTimeAsync(9999);
    expect(mockClients).toHaveLength(2);
    mockStart = 'online';
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(mockClients).toHaveLength(3);
    expect(XmppService.connection.state).toBe('ONLINE');
    expect(XmppService.connection.attempts).toBe(0);
  });

  it('stops retrying on SASL auth failure', async () => {
    mockStart = 'auth-fail';
    await expect(XmppService.connect(config)).rejects.toThrow('not-authorized');
    expect(XmppService.connection.state).toBe('AUTH_FAILED');
    expect(XmppService.getState()).toBe('error');
    await jest.advanceTimersByTimeAsync(300000);
    expect(mockClients).toHaveLength(1);
  });

  it('an explicit disconnect() does not trigger a reconnect from the dying client', async () => {
    await XmppService.connect(config);
    await flush();
    await XmppService.disconnect();
    mockClients[0]!.emit('disconnect', { clean: true });
    mockClients[0]!.emit('offline');
    expect(XmppService.getState()).toBe('disconnected');
    await jest.advanceTimersByTimeAsync(300000);
    expect(mockClients).toHaveLength(1);
  });

  it('re-injects the saved XEP-0198 resume id into the next client', async () => {
    await XmppService.connect(config);
    await flush();
    mockClients[0]!.streamManagement.id = 'sm-123';
    mockClients[0]!.streamManagement.inbound = 7;
    mockClients[0]!.emit('disconnect', { clean: false });
    await jest.advanceTimersByTimeAsync(5000);
    await flush();
    expect(mockClients[1]!.streamManagement.id).toBe('sm-123');
    expect(mockClients[1]!.streamManagement.inbound).toBe(7);
  });
});

import { XmppHistory } from '@/xmpp/XmppHistory';
import { persistAndDedupe } from '@/xmpp/XmppService';
import type { XmppMessage } from '@/types/xmpp';

function incoming(overrides: Partial<XmppMessage>): XmppMessage {
  return {
    id: 'seed-1',
    from: 'rolando@example.org',
    to: 'me@example.org',
    type: 'chat',
    body: 'Recibido · preparando…',
    timestamp: '2026-07-22T21:00:00.000Z',
    direction: 'in',
    isGroup: false,
    ...overrides,
  };
}

describe('XEP-0308 cache persistence', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stores ordinary seed ids and folds archived corrections into one row', async () => {
    const record = jest.spyOn(XmppHistory, 'recordMessage').mockResolvedValue(true);
    const apply = jest.spyOn(XmppHistory, 'applyCorrectionByStanzaId').mockResolvedValue(true);

    const result = await persistAndDedupe('rolando@example.org', [
      incoming({}),
      incoming({
        id: 'edit-1',
        replaceId: 'seed-1',
        body: 'Respuesta final',
        timestamp: '2026-07-22T21:00:03.000Z',
        wasEncrypted: true,
        encryptionStatus: 'encrypted',
      }),
    ]);

    expect(record).toHaveBeenCalledWith(
      'rolando@example.org',
      'Recibido · preparando…',
      'in',
      '2026-07-22T21:00:00.000Z',
      null,
      null,
      null,
      'seed-1',
      null,
      null,
      null,
      null,
      null,
      false,
    );
    expect(apply).toHaveBeenCalledWith(
      'rolando@example.org',
      'seed-1',
      'Respuesta final',
      '2026-07-22T21:00:03.000Z',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'seed-1',
      body: 'Respuesta final',
      encryptionStatus: 'encrypted',
    });
  });
});

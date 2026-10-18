import { KeyTransportCounter, MemoryStore } from '@/omemo2';

const alice = { jid: 'alice@x.org', rid: 42 };
const bob = { jid: 'bob@x.org', rid: 7 };

describe('contador de key transport', () => {
  test('persiste entre instancias sobre el mismo OmemoStore', async () => {
    const store = new MemoryStore();
    const first = new KeyTransportCounter(store);
    expect(await first.increment(alice)).toBe(1);
    expect(await first.increment(alice)).toBe(2);

    // Simula reinicio de la app: un contador nuevo, mismo store.
    const second = new KeyTransportCounter(store);
    expect(await second.increment(alice)).toBe(3);
    expect(store.data.get('omemo2:recv:alice@x.org:42')).toBe('3');
  });

  test('reset borra sólo el contador de ese dispositivo', async () => {
    const store = new MemoryStore();
    const counter = new KeyTransportCounter(store);
    await counter.increment(alice);
    await counter.increment(alice);
    await counter.increment(bob);
    await counter.reset(alice);
    expect(await counter.increment(alice)).toBe(1);
    expect(await counter.increment(bob)).toBe(2);
  });
});

import 'react-native-get-random-values';
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { MemoryStore, SessionManager, SPK_MAX_AGE_MS } from '@/omemo2';
import { NODE_BUNDLES, Omemo2Engine } from '@/xmpp/omemo2';

const DAY = 24 * 60 * 60 * 1000;

describe('rotación semanal del signed prekey', () => {
  test('no rota antes de 7 días y rota al cumplirlos (reloj inyectable)', async () => {
    const store = new MemoryStore();
    const sm = await SessionManager.load(store, 5, 1_000);
    expect(sm.bundle().spkId).toBe(1);

    expect(await sm.rotateSignedPreKeyIfOlderThan(SPK_MAX_AGE_MS, 1_000 + 7 * DAY - 1)).toBe(false);
    expect(sm.bundle().spkId).toBe(1);
    expect(await sm.rotateSignedPreKeyIfOlderThan(SPK_MAX_AGE_MS, 1_000 + 7 * DAY)).toBe(true);
    expect(sm.bundle().spkId).toBe(2);
  });

  test('un dispositivo previo sin timestamp lo recibe al cargar y no rota de golpe', async () => {
    const store = new MemoryStore();
    await SessionManager.load(store, 5, 1_000);
    const raw = JSON.parse((await store.get('omemo2:device'))!);
    delete raw.spkCreatedAt;
    await store.set('omemo2:device', JSON.stringify(raw));

    const loaded = await SessionManager.load(store, 5, 50_000);
    expect(await loaded.rotateSignedPreKeyIfOlderThan(SPK_MAX_AGE_MS, 50_000)).toBe(false);
    expect(await loaded.rotateSignedPreKeyIfOlderThan(SPK_MAX_AGE_MS, 50_000 + 7 * DAY)).toBe(true);
  });

  test('el motor republica el bundle con el spk nuevo', async () => {
    const store = new MemoryStore();
    const iqs: Element[] = [];
    const deps = {
      jid: 'alice@x.org/phone',
      store,
      request: async (iq: Element) => { iqs.push(iq); return xml('iq', { type: 'result' }); },
      send: async () => {},
    };
    await Omemo2Engine.create(deps);
    const raw = JSON.parse((await store.get('omemo2:device'))!);
    raw.spkCreatedAt = 0;
    await store.set('omemo2:device', JSON.stringify(raw));

    const engine = await Omemo2Engine.create(deps);
    const before = iqs.length;
    expect(await engine.rotateSpkIfStale(SPK_MAX_AGE_MS + 1)).toBe(true);
    const published = iqs.slice(before)
      .map((iq) => iq.getChild('pubsub')?.getChild('publish'))
      .find((p) => p?.attrs.node === NODE_BUNDLES);
    expect(published?.getChild('item')?.attrs.id).toBe(String(engine.deviceId));
    expect(JSON.parse((await store.get('omemo2:device'))!).spk.id).toBe(2);
  });
});

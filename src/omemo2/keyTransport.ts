// Contador de mensajes recibidos de un dispositivo sin contestarle
// (XEP-0384 §4.6). Vivir sólo en memoria hacía que cada arranque de la app
// reiniciara la cuenta y nunca se disparara el key transport en sesiones
// largas; aquí se persiste en el OmemoStore.
import type { DeviceRef } from './session';
import type { OmemoStore } from './store';

const key = (dev: DeviceRef) => `omemo2:recv:${dev.jid}:${dev.rid}`;

export class KeyTransportCounter {
  constructor(private readonly store: OmemoStore) {}

  async increment(dev: DeviceRef): Promise<number> {
    const raw = await this.store.get(key(dev));
    const next = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
    await this.store.set(key(dev), String(next));
    return next;
  }

  /** Tras cifrarle (o enviarle un key transport) volvemos a contar desde cero. */
  reset(dev: DeviceRef): Promise<void> {
    return this.store.remove(key(dev));
  }
}

import type { XmppMessage } from '@/types/xmpp';

/** True si el mensaje viajó cifrado (cualquier protocolo). 'encrypted' es el valor heredado de filas del historial. */
export function isEncrypted(status: XmppMessage['encryptionStatus']): boolean {
  return status === 'omemo2' || status === 'omemo' || status === 'encrypted';
}

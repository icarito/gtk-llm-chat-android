import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';

export async function decryptStanzaIfEncrypted(stanza: Element, fromJid: string) {
  const legacyEncrypted = stanza.getChild('encrypted', 'eu.siacs.conversations.axolotl');
  const omemo2Encrypted = stanza.getChild('encrypted', 'urn:xmpp:omemo:2');
  const encryptedNode = legacyEncrypted || omemo2Encrypted;
  if (!encryptedNode) {
    return { decryptedBody: null, wasEncrypted: false, encryptionStatus: undefined };
  }
  if (!Omemo.isEnabled()) {
    return { decryptedBody: '🔒 [Mensaje OMEMO: activa el cifrado para descifrarlo]', wasEncrypted: true, encryptionStatus: 'undecryptable' as const };
  }
  if (omemo2Encrypted) {
    return { decryptedBody: '🔒 [Mensaje OMEMO 2: este backend aún no puede descifrarlo]', wasEncrypted: true, encryptionStatus: 'undecryptable' as const };
  }

  try {
    const decryptedText = await Omemo.decryptMessage(fromJid, encryptedNode);
    if (!decryptedText) {
      return { decryptedBody: null, wasEncrypted: false, encryptionStatus: undefined };
    }

    try {
      const parsed = JSON.parse(decryptedText);
      if (parsed && typeof parsed === 'object' && parsed.body !== undefined) {
        return {
          decryptedBody: parsed.body,
          wasEncrypted: true,
          encryptionStatus: 'encrypted' as const,
          decryptedMetadata: {
            quickResponses: parsed.quickResponses,
            commands: parsed.commands,
            replyTo: parsed.replyTo,
            oobUrl: parsed.oobUrl,
          }
        };
      }
    } catch {
      // Not a JSON string, just raw text body
    }

    return { decryptedBody: decryptedText, wasEncrypted: true, encryptionStatus: 'encrypted' as const };
  } catch (e) {
    if (e instanceof Error && e.message.includes('Message was not encrypted for our device ID')) {
      // Normal for MAM/carbons created before this installation published its
      // device id, and for copies addressed exclusively to another own device.
      // Return a visible placeholder rather than null: callers treat
      // `wasEncrypted && !decryptedBody` as an empty body and silently drop
      // the message (see the `if (carbonBody)` / `if (!body) return;` gates),
      // which made this failure indistinguishable from "never arrived".
      return {
        decryptedBody: '🔒 [Mensaje OMEMO: no descifrable en este dispositivo]',
        wasEncrypted: true,
        encryptionStatus: 'undecryptable' as const,
      };
    }
    console.error('[OMEMO] Failed to decrypt inbound message from', fromJid, e);
    return { decryptedBody: '🔒 [Error al desencriptar mensaje OMEMO]', wasEncrypted: true, encryptionStatus: 'undecryptable' as const };
  }
}

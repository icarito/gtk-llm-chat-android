import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import { bareJid } from '@/xmpp/parse';
import { getOmemo2 } from '@/xmpp/omemo2';
import { resolveMucSender } from '@/xmpp/muc';
import { materializeAesgcm } from '@/xmpp/media';
import { AESGCM_SCHEME } from '@/omemo2';

/**
 * Descifra una stanza entrante (en vivo, carbon o MAM). `fromJid` es el
 * remitente real (el propio JID en copias salientes). Un mensaje con las dos
 * variantes (OpenClaw dual) se intenta primero por OMEMO 2.
 */
export async function decryptStanzaIfEncrypted(stanza: Element, fromJid: string, live = true) {
  const legacyEncrypted = stanza.getChild('encrypted', 'eu.siacs.conversations.axolotl');
  const omemo2Encrypted = stanza.getChild('encrypted', 'urn:xmpp:omemo:2');
  if (!legacyEncrypted && !omemo2Encrypted) {
    return { decryptedBody: null, wasEncrypted: false, encryptionStatus: 'none' as const };
  }
  if (omemo2Encrypted) {
    const engine = getOmemo2();
    if (!engine) {
      if (!legacyEncrypted) {
        return { decryptedBody: '🔒 [Mensaje OMEMO 2: activa el cifrado para descifrarlo]', wasEncrypted: true, encryptionStatus: 'undecryptable' as const };
      }
    } else {
      // En una sala `fromJid` es room/nick: el remitente real sale del mapa de ocupantes o de muc#user.
      const sender = stanza.attrs.type === 'groupchat' ? resolveMucSender(stanza, engine.ownBare, live) : bareJid(fromJid);
      const group = stanza.attrs.type === 'groupchat';
      const to = stanza.attrs.to ? bareJid(stanza.attrs.to as string) : undefined;
      const expectedTo = group ? bareJid((stanza.attrs.from as string) ?? '') : sender === engine.ownBare ? to : engine.ownBare;
      const r = sender
        ? await engine.decrypt(stanza, sender, live, expectedTo)
        : { body: '🔒 [OMEMO 2: remitente desconocido en la sala]', status: 'undecryptable' as const };
      if (r.status === 'omemo2' || !legacyEncrypted) {
        const attachmentLocalUri = r.body.startsWith(AESGCM_SCHEME)
          ? await materializeAesgcm(r.body)
          : null;
        return {
          decryptedBody: r.body,
          wasEncrypted: true,
          encryptionStatus: r.status,
          attachmentLocalUri,
        };
      }
    }
  }
  const encryptedNode = legacyEncrypted!;
  if (!Omemo.isEnabled()) {
    return { decryptedBody: '🔒 [Mensaje OMEMO: activa el cifrado para descifrarlo]', wasEncrypted: true, encryptionStatus: 'undecryptable' as const };
  }

  try {
    const decryptedText = await Omemo.decryptMessage(fromJid, encryptedNode);
    if (!decryptedText) {
      return { decryptedBody: null, wasEncrypted: false, encryptionStatus: 'none' as const };
    }

    try {
      const parsed = JSON.parse(decryptedText);
      if (parsed && typeof parsed === 'object' && parsed.body !== undefined) {
        return {
          decryptedBody: parsed.body,
          wasEncrypted: true,
          encryptionStatus: 'omemo' as const,
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

    return { decryptedBody: decryptedText, wasEncrypted: true, encryptionStatus: 'omemo' as const };
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

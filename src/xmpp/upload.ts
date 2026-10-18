/** XEP-0363 (HTTP Upload) + XEP-0066 (OOB): subir un adjunto y enviarlo como link. */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { DISCO_INFO_NS, DISCO_ITEMS_NS, HTTP_UPLOAD_NS, OOB_NS } from '@/xmpp/ns';
import { session } from '@/xmpp/session';
import { addMessageToMap } from '@/xmpp/messages';
import { getOmemo2 } from '@/xmpp/omemo2';
import { buildAesgcmUrl, encryptMedia } from '@/omemo2';

// JID del componente XEP-0363. undefined = sin descubrir; null = el server no
// tiene uno (no reintentar el disco en cada envío).
let uploadHostCache: string | null | undefined = undefined;

/** Otra cuenta puede estar en otro servidor: re-descubrir en la próxima sesión. */
export function resetUploadHost() {
  uploadHostCache = undefined;
}

/**
 * JID del componente XEP-0363 del server (cacheado). null si no tiene uno.
 *
 * disco#items del dominio -> disco#info de cada item -> el que anuncie la
 * feature urn:xmpp:http:upload:0. TRAMPA: el componente vive en un subdominio
 * (upload.dominio), NO en el dominio base — hay que descubrirlo.
 */
async function resolveUploadHost(): Promise<string | null> {
  if (uploadHostCache !== undefined) return uploadHostCache;
  const domain = session.account?.jid?.split('@')[1];
  const client = session.client;
  if (!client || !domain) return null;
  try {
    const items = await client.iqCaller.request(
      xml('iq', { type: 'get', to: domain, id: `disco-items-${Date.now().toString(36)}` },
        xml('query', { xmlns: DISCO_ITEMS_NS })),
      15000,
    );
    const query = items.getChild('query', DISCO_ITEMS_NS);
    const candidates = (query?.getChildren('item') ?? [])
      .map((item: Element) => item.attrs.jid as string | undefined)
      .filter((jid): jid is string => Boolean(jid));
    for (const candidate of candidates) {
      try {
        const info = await client.iqCaller.request(
          xml('iq', { type: 'get', to: candidate, id: `disco-info-${Date.now().toString(36)}` },
            xml('query', { xmlns: DISCO_INFO_NS })),
          15000,
        );
        const features = info.getChild('query', DISCO_INFO_NS)?.getChildren('feature') ?? [];
        if (features.some((f: Element) => f.attrs.var === HTTP_UPLOAD_NS)) {
          uploadHostCache = candidate;
          return candidate;
        }
      } catch {
        // Ese componente no respondió: seguir con el siguiente.
      }
    }
  } catch {
    // El server no respondió el disco: no reintentar en cada envío.
  }
  uploadHostCache = null;
  return null;
}

/** Pide un slot de subida (XEP-0363): put/get URLs + headers para el PUT. */
async function requestUploadSlot(
  host: string,
  filename: string,
  size: number,
  contentType: string,
): Promise<{ putUrl: string; getUrl: string; headers: Record<string, string> }> {
  const client = session.client;
  if (!client) throw new Error('XMPP no conectado');
  const result = await client.iqCaller.request(
    xml('iq', { type: 'get', to: host, id: `upload-${Date.now().toString(36)}` },
      xml('request', {
        xmlns: HTTP_UPLOAD_NS,
        filename,
        size: String(size),
        'content-type': contentType,
      })),
    30000,
  );
  const slot = result.getChild('slot', HTTP_UPLOAD_NS);
  const put = slot?.getChild('put');
  const get = slot?.getChild('get');
  // Las URLs vienen en ATRIBUTOS (url=), no como texto del elemento.
  const putUrl = put?.attrs.url as string | undefined;
  const getUrl = get?.attrs.url as string | undefined;
  if (!putUrl || !getUrl) throw new Error('El servidor no devolvió un slot válido');
  const headers: Record<string, string> = {};
  for (const header of put?.getChildren('header') ?? []) {
    const name = header.attrs.name as string | undefined;
    const value = header.text();
    if (name && value) headers[name] = value;
  }
  return { putUrl, getUrl, headers };
}

/**
 * Sube un archivo por XEP-0363 y lo envía como link OOB (XEP-0066).
 *
 * `blob` son los bytes ya leídos (el picker/FS los provee). Devuelve el
 * get_uri publicado. Igual que el plugin y el cliente GTK: el link va en el
 * body Y en <x jabber:x:oob>, para que lo vea cualquier cliente.
 *
 * En un chat 1:1 con OMEMO 2 el archivo se cifra ANTES de subirlo
 * (XEP-0454) y la URL `aesgcm://…#iv+key` viaja como cuerpo del mensaje
 * cifrado, nunca como OOB en claro. Sin OMEMO 2 la subida no cambia.
 */
export async function sendFile(
  to: string,
  blob: Blob,
  filename: string,
  contentType = 'application/octet-stream',
  type: 'chat' | 'groupchat' = 'chat',
): Promise<string> {
  const client = session.client;
  if (!client) throw new Error('XMPP no conectado');
  const host = await resolveUploadHost();
  if (!host) throw new Error('El servidor no tiene servicio de subida (XEP-0363)');

  // Sólo 1:1: en groupchat no hay OMEMO 2 (el cifrado de archivos no aplica).
  const omemo2 = type === 'chat' ? getOmemo2() : null;
  const omemo2Eligible = omemo2 ? await omemo2.canEncryptTo(to) : false;
  let uploadBlob = blob;
  let uploadType = contentType;
  let media: { key: Uint8Array; iv: Uint8Array } | null = null;
  if (omemo2Eligible) {
    const plaintext = new Uint8Array(await blob.arrayBuffer());
    const enc = encryptMedia(plaintext);
    // Copia a un ArrayBuffer propio: BlobPart exige ArrayBuffer, no ArrayBufferLike.
    const ciphertext = new Uint8Array(enc.ciphertext.length);
    ciphertext.set(enc.ciphertext);
    uploadBlob = new Blob([ciphertext.buffer], { type: 'application/octet-stream' });
    uploadType = 'application/octet-stream';
    media = { key: enc.key, iv: enc.iv };
  }

  const slot = await requestUploadSlot(host, filename, uploadBlob.size, uploadType);
  const putResponse = await fetch(slot.putUrl, {
    method: 'PUT',
    body: uploadBlob,
    headers: { 'Content-Type': uploadType, ...slot.headers },
  });
  if (!putResponse.ok) {
    throw new Error(`La subida falló (HTTP ${putResponse.status})`);
  }

  const id = `oc-${Date.now().toString(36)}`;
  const timestamp = new Date().toISOString();

  if (omemo2 && media) {
    const aesgcmUrl = buildAesgcmUrl(slot.getUrl, media.key, media.iv);
    const encryptedChildren = await omemo2.encryptOutgoing(to, id, aesgcmUrl);
    if (!encryptedChildren) {
      throw new Error(`No hay dispositivos OMEMO 2 utilizables para ${to}`);
    }
    await client.send(xml('message', { type, to, id }, ...encryptedChildren));
    addMessageToMap({
      id,
      from: session.account?.jid ?? '',
      to,
      type,
      body: aesgcmUrl,
      timestamp,
      direction: 'out',
      isGroup: false,
      wasEncrypted: true,
      encryptionStatus: 'omemo2',
    });
    XmppHistory.recordMessage(
      to, aesgcmUrl, 'out', timestamp, null,
      null, null, null, null, null, null, null, null, true,
    )
      .catch(() => {});
    return aesgcmUrl;
  }

  if (session.account?.omemoEnabled && Omemo.isEnabled()) {
    const isGroup = type === 'groupchat';
    const richPlaintext = JSON.stringify({ body: slot.getUrl, oobUrl: slot.getUrl });
    const { encryptedXml, wasEncrypted } = await Omemo.encryptMessage(to, richPlaintext, isGroup);
    if (wasEncrypted && encryptedXml) {
      await client.send(
        xml(
          'message',
          { type, to, id },
          encryptedXml,
        ),
      );
      addMessageToMap({
        id,
        from: session.account?.jid ?? '',
        to,
        type,
        body: slot.getUrl,
        timestamp,
        direction: 'out',
        isGroup: type === 'groupchat',
        oobUrl: slot.getUrl,
        wasEncrypted: true,
        encryptionStatus: 'encrypted',
      });
      XmppHistory.recordMessage(
        to, slot.getUrl, 'out', timestamp, null,
        null, null, null, slot.getUrl, null, null, null, null, true,
      )
        .catch(() => {});
      return slot.getUrl;
    }
    throw new Error(`No hay dispositivos OMEMO compatibles para ${to}`);
  }

  await client.send(
    xml(
      'message',
      { type, to, id },
      xml('body', {}, slot.getUrl),
      xml('x', { xmlns: OOB_NS }, xml('url', {}, slot.getUrl)),
    ),
  );
  addMessageToMap({
    id,
    from: session.account?.jid ?? '',
    to,
    type,
    body: slot.getUrl,
    timestamp,
    direction: 'out',
    isGroup: type === 'groupchat',
    oobUrl: slot.getUrl,
  });
  XmppHistory.recordMessage(to, slot.getUrl, 'out', timestamp, null, null, null, null, slot.getUrl)
    .catch(() => {});
  return slot.getUrl;
}

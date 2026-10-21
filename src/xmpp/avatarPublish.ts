/**
 * XEP-0084: publicar el avatar propio (data + metadata). Mismo shape que
 * xat/addon/xat_xmpp/xmpp/avatar.gd (build_publish_*): id del item = sha1 de
 * los bytes, publish-options con max_items 1 y acceso por presencia.
 */
import { xml } from '@xmpp/client';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex } from '@noble/hashes/utils';
import { AVATAR_DATA_NODE, AVATAR_METADATA_NODE, PUBSUB_NS } from '@/xmpp/ns';
import { fetchAvatarData } from '@/xmpp/pep';
import { usableClient } from '@/xmpp/session';

const DATA_FORMS_NS = 'jabber:x:data';
const PUBLISH_OPTIONS_NS = 'http://jabber.org/protocol/pubsub#publish-options';

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function avatarId(bytes: Uint8Array): string {
  return bytesToHex(sha1(bytes));
}

function field(name: string, value: string) {
  return xml('field', { var: name }, xml('value', {}, value));
}

function publishIq(id: string, node: string, itemId: string, payload: ReturnType<typeof xml>) {
  return xml('iq', { type: 'set', id },
    xml('pubsub', { xmlns: PUBSUB_NS },
      xml('publish', { node }, xml('item', { id: itemId }, payload)),
      xml('publish-options', {},
        xml('x', { xmlns: DATA_FORMS_NS, type: 'submit' },
          field('FORM_TYPE', PUBLISH_OPTIONS_NS),
          field('pubsub#access_model', 'presence'),
          field('pubsub#max_items', '1'),
          field('pubsub#persist_items', '1')))));
}

export function buildPublishData(iqId: string, itemId: string, base64: string) {
  return publishIq(iqId, AVATAR_DATA_NODE, itemId, xml('data', { xmlns: AVATAR_DATA_NODE }, base64));
}

export function buildPublishMetadata(
  iqId: string, itemId: string, bytes: number, mime: string, width: number, height: number,
) {
  return publishIq(iqId, AVATAR_METADATA_NODE, itemId,
    xml('metadata', { xmlns: AVATAR_METADATA_NODE },
      xml('info', { bytes: String(bytes), id: itemId, type: mime, width: String(width), height: String(height) })));
}

/** Publica data y luego metadata; deja el avatar propio en la caché/store. */
export async function publishAvatar(
  bareJid: string, base64: string, mime: string, width: number, height: number,
): Promise<void> {
  const client = usableClient();
  if (!client) throw new Error('Sin conexión');
  const bytes = base64ToBytes(base64);
  const id = avatarId(bytes);
  const tag = Date.now().toString(36);
  await client.iqCaller.request(buildPublishData(`avatar-pub-data-${tag}`, id, base64), 30000);
  await client.iqCaller.request(
    buildPublishMetadata(`avatar-pub-meta-${tag}`, id, bytes.length, mime, width, height), 15000);
  // Misma caché por sha que fetchAvatarData: así la lee sin pedirla de nuevo.
  if (Platform.OS !== 'web') {
    const dir = `${FileSystem.cacheDirectory}avatars/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(`${dir}${id}.img`, base64, { encoding: FileSystem.EncodingType.Base64 });
  }
  await fetchAvatarData(bareJid, id);
}

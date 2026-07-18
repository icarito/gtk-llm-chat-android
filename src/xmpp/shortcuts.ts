import { Platform } from 'react-native';
import * as QuickActions from 'expo-quick-actions';
import { displayName } from '@/xmpp/presence';

/**
 * Shortcuts de launcher por contacto (long-press sobre el icono de la app),
 * como cualquier app de mensajería. Se publican como dynamic shortcuts de
 * Android vía expo-quick-actions y se refrescan con cada cambio de roster.
 *
 * El tap del shortcut llega como Action con params.jid; el ruteo vive en
 * app/_layout.tsx (routeFromShortcut), por el mismo camino que las
 * notificaciones: SIEMPRE por jid re-encodeado, nunca por url ya encodeada
 * (expo-router la decodifica al empujar y la ruta recibe basura).
 */

// Android permite ~4 shortcuts dinámicos visibles; más se truncan en silencio.
const MAX_SHORTCUTS = 4;

let lastPublishedKey = '';

export async function updateContactShortcuts(
  contacts: { jid: string; name?: string | null }[],
): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (!(await QuickActions.isSupported())) return;
    const items = contacts.slice(0, MAX_SHORTCUTS).map((contact) => ({
      id: `chat:${contact.jid}`,
      title: displayName(contact.jid, contact.name),
      icon: null,
      params: { jid: contact.jid },
    }));
    // El roster notifica con cada cambio de presencia; republicar shortcuts
    // idénticos en cada uno es trabajo inútil para el launcher.
    const key = items.map((item) => `${item.id}|${item.title}`).join('\n');
    if (key === lastPublishedKey) return;
    lastPublishedKey = key;
    await QuickActions.setItems(items);
  } catch {
    // Shortcuts son cosmético: nunca deben romper el flujo del roster.
  }
}

/** JID de un Action de shortcut, o null si no es uno nuestro. */
export function shortcutJid(action: { id?: string; params?: Record<string, unknown> | null }): string | null {
  const fromParams = action.params?.jid;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  if (typeof action.id === 'string' && action.id.startsWith('chat:')) {
    return action.id.slice('chat:'.length);
  }
  return null;
}

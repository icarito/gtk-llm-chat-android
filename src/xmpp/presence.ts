import { Colors } from '@/constants/theme';

/**
 * Color del círculo de presencia, como el roster de GTK: verde disponible,
 * ámbar ausente, rojo ocupado, gris desconectado. Antes esto era binario
 * (verde/gris) y un agente en dnd se pintaba igual que uno disponible.
 */
export function presenceColor(presence: string): string {
  switch (presence) {
    case 'online':
      return Colors.success;
    case 'away':
    case 'xa':
      return Colors.warning;
    case 'dnd':
      return Colors.error;
    default:
      return Colors.muted;
  }
}

export function presenceLabel(presence: string): string {
  switch (presence) {
    case 'online':
      return 'En línea';
    case 'away':
      return 'Ausente';
    case 'xa':
      return 'No disponible';
    case 'dnd':
      return 'Ocupado';
    default:
      return 'Desconectado';
  }
}

export function isOnline(presence: string): boolean {
  return presence !== 'offline';
}

/**
 * Nombre a mostrar. Igual que GTK: el del roster si existe, si no la parte
 * local del JID ("rolando@hablar…/x" -> "rolando"), que es infinitamente más
 * legible que el JID crudo.
 */
export function displayName(jid: string, name?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const bare = jid.split('/')[0] ?? jid;
  const local = bare.split('@')[0];
  return local || bare;
}

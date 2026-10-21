import { memo, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { displayName, presenceColor } from '@/xmpp/presence';
import { XmppService } from '@/xmpp/XmppService';

function safeGetAvatarUri(bare: string): string | null {
  try { return typeof XmppService.getAvatarUri === 'function' ? XmppService.getAvatarUri(bare) : null; }
  catch { return null; }
}

/** Resuelve el bare JID cuyo avatar consultar para un remitente:
 *  - 1:1 -> el propio bare.
 *  - MUC -> el `realJid` del ocupante (XEP-0045) si la sala lo expone; en
 *    salas anónimas (o nick desconocido) devuelve null (no hay avatar).
 */
export function avatarTargetJid(full: string): string | null {
  const slash = full.indexOf('/');
  if (slash < 0) return full.split('/')[0] || full || null;
  const roomBare = full.slice(0, slash);
  const nick = full.slice(slash + 1);
  if (!nick) return null;
  try {
    const room = XmppService.rooms?.get?.(roomBare);
    const realJid = room?.occupants?.[nick]?.realJid;
    if (!realJid) return null;
    return realJid.split('/')[0] || realJid || null;
  } catch { return null; }
}

/** Avatar XEP-0084 del contacto `jid` (bare por dentro). Si aún no lo tenemos,
 *  lo pedimos; se re-renderiza cuando publica uno nuevo (PEP). */
function useAvatar(jid: string): string | null {
  const [uri, setUri] = useState<string | null>(() => {
    const target = avatarTargetJid(jid);
    return target ? safeGetAvatarUri(target) : null;
  });
  useEffect(() => {
    let mounted = true;
    const target = avatarTargetJid(jid);
    if (!target) { if (mounted) setUri(null); return; }
    const current = safeGetAvatarUri(target);
    if (mounted) setUri(current);
    if (!current && typeof XmppService.fetchAvatar === 'function') {
      try { void XmppService.fetchAvatar(target); } catch { /* noop */ }
    }
    if (typeof XmppService.onAvatarChange !== 'function') return;
    const off = XmppService.onAvatarChange((changed, u) => {
      if (mounted && changed === target) setUri(u);
    });
    return () => {
      mounted = false;
      try { off?.(); } catch { /* noop */ }
    };
  }, [jid]);
  return uri;
}

type Props = {
  jid: string;
  name?: string | null;
  size?: number;
};

function AvatarImpl({ jid, name, size = 30 }: Props) {
  const uri = useAvatar(jid);
  const diameter = { width: size, height: size, borderRadius: size / 2 } as const;
  if (uri) {
    return (
      <View style={[styles.circle, diameter]}>
        <Image source={{ uri }} style={[styles.img, { width: size, height: size }]} />
      </View>
    );
  }
  return (
    <View style={[styles.circle, styles.fallback, diameter]}>
      <Text style={[styles.initial, { fontSize: Math.round(size * 0.44) }]}>
        {(displayName(jid, name) || '?').slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

export const Avatar = memo(AvatarImpl);

type PresenceProps = {
  jid: string;
  name?: string | null;
  size?: number;
  /** Presencia (red/away/available/offline/…): dibuja un anillo de color. */
  presence?: string;
  /** Ancho del anillo (px). */
  ring?: number;
};

/** Avatar con anillo de presencia: para los agentes la "orbe" de presencia ES el
 *  avatar mismo con un anillo de color (en vez de un punto separado). */
export const AvatarWithPresence = memo(function AvatarWithPresence({
  jid, name, size = 30, presence, ring = 2.5,
}: PresenceProps) {
  const color = presence ? presenceColor(presence) : Colors.surfaceBorder;
  return (
    <View style={{ borderRadius: (size + ring * 2) / 2, borderWidth: ring, borderColor: color, padding: 0 }}>
      <Avatar jid={jid} name={name} size={size} />
    </View>
  );
});

const styles = StyleSheet.create({
  circle: { overflow: 'hidden', backgroundColor: Colors.surfaceBorder },
  img: { resizeMode: 'cover' },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  initial: { color: Colors.textDim, fontWeight: '700' },
});

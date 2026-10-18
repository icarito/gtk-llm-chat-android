import { memo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { omemo2Api, type Omemo2Device, type TrustState } from '@/xmpp/omemo2';
import { formatFingerprint } from './format';

const LABEL: Record<TrustState, string> = {
  blind: 'Confianza ciega',
  verified: 'Verificado',
  distrusted: 'Desconfiado',
};
const COLOR: Record<TrustState, string> = {
  blind: Colors.warning,
  verified: Colors.success,
  distrusted: Colors.error,
};

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.action} accessibilityRole="button">
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function DeviceRowImpl({ device }: { device: Omemo2Device }) {
  const { jid, rid, identity, trusted } = device;
  const set = (s: TrustState) => void omemo2Api.setTrust(jid, rid, s);
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.id}>{`Dispositivo ${rid}${device.own ? ' (este)' : ''}`}</Text>
        {trusted ? <Text style={[styles.state, { color: COLOR[trusted] }]}>{LABEL[trusted]}</Text> : null}
      </View>
      <Text style={styles.fp} selectable>
        {identity ? formatFingerprint(identity) : 'Huella aún desconocida'}
      </Text>
      {trusted ? (
        <View style={styles.actions}>
          {trusted !== 'verified' ? <Action label="Verificar" onPress={() => set('verified')} /> : null}
          {trusted !== 'distrusted' ? <Action label="Desconfiar" onPress={() => set('distrusted')} /> : null}
          {trusted !== 'blind' ? <Action label="Volver a confianza ciega" onPress={() => set('blind')} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export const DeviceRow = memo(DeviceRowImpl);

const styles = StyleSheet.create({
  row: { backgroundColor: Colors.surface, borderColor: Colors.surfaceBorder, borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
  head: { flexDirection: 'row', justifyContent: 'space-between' },
  id: { color: Colors.text, fontWeight: '600' },
  state: { fontSize: 13, fontWeight: '600' },
  fp: { color: Colors.secondary, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { borderColor: Colors.primary, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  actionText: { color: Colors.primary, fontSize: 13 },
});

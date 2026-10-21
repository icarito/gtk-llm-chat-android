import { StyleSheet, View } from 'react-native';
import { Colors } from '@/constants/theme';
import FleetMonitor from '@/components/fleet/FleetMonitor';

export default function FleetScreen() {
  return (
    <View style={styles.container}>
      <FleetMonitor />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
});

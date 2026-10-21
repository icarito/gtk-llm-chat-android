import type { ColorValue } from 'react-native';
import { View, StyleSheet, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { useUnreadTotal } from '@/chat/stores';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const tab = (title: string, icon: IconName, badge?: number) => ({
  title,
  tabBarAccessibilityLabel: badge && badge > 0 ? `${title}, ${badge} no leídos` : title,
  tabBarIcon: ({ color, size }: { color: ColorValue; size: number }) => (
    <View style={styles.iconWrap}>
      <Ionicons name={icon} size={size} color={color} />
      {badge && badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </View>
  ),
});

export default function TabLayout() {
  const total = useUnreadTotal();
  return (
    <Tabs
      initialRouteName="xmpp"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.muted,
        tabBarStyle: { backgroundColor: Colors.surface, borderTopColor: Colors.surfaceBorder },
      }}
    >
      {/* `index` sólo redirige a Inicio: sin pestaña. */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="xmpp" options={tab('Inicio', 'chatbubbles-outline', total)} />
      <Tabs.Screen name="flota" options={tab('Flota', 'hardware-chip-outline')} />
      <Tabs.Screen name="salas" options={tab('Salas', 'people-outline')} />
      <Tabs.Screen name="yo" options={tab('Yo', 'person-circle-outline')} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -3,
    right: -7,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700' },
});

import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const tab = (title: string, icon: IconName) => ({
  title,
  tabBarIcon: ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={icon} size={size} color={color} />,
});

export default function TabLayout() {
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
      <Tabs.Screen name="xmpp" options={tab('Inicio', 'chatbubbles-outline')} />
      <Tabs.Screen name="flota" options={tab('Flota', 'hardware-chip-outline')} />
      <Tabs.Screen name="salas" options={tab('Salas', 'people-outline')} />
      <Tabs.Screen name="yo" options={tab('Yo', 'person-circle-outline')} />
    </Tabs>
  );
}

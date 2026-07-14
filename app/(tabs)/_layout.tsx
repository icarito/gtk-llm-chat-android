import { Tabs } from 'expo-router';

/**
 * There is only one real screen here (the roster); `index` merely redirects to
 * it. A tab bar with one destination — plus a phantom tab expo-router
 * auto-generates for the redirect route — is pure noise, so it stays hidden.
 * Restore `tabBarStyle` and per-screen icons if a second destination lands.
 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
      }}
    />
  );
}

const mockPresented: unknown[] = [];
const mockDismiss = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: () => Promise.resolve(mockPresented),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
}));
jest.mock('expo-constants', () => ({}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));

import { dismissPushNotifications, handleIncomingNotification, setAppForeground } from '@/xmpp/notifications';

const n = (type: string) => ({ request: { trigger: { type } } }) as never;

describe('handleIncomingNotification', () => {
  it('silencia el push remoto con la app en primer plano', async () => {
    setAppForeground(true);
    expect((await handleIncomingNotification(n('push'))).shouldShowBanner).toBe(false);
  });
  it('muestra la notificación local en primer plano', async () => {
    setAppForeground(true);
    expect((await handleIncomingNotification(n('unknown'))).shouldShowBanner).toBe(true);
  });
  it('muestra el push en segundo plano', async () => {
    setAppForeground(false);
    expect((await handleIncomingNotification(n('push'))).shouldShowBanner).toBe(true);
  });
});

test('al volver a primer plano retira sólo los push del SO', async () => {
  mockPresented.splice(0, mockPresented.length,
    { request: { identifier: 'fcm', trigger: { type: 'push' } } },
    { request: { identifier: 'local', trigger: null } });
  mockDismiss.mockClear();
  await dismissPushNotifications();
  expect(mockDismiss.mock.calls).toEqual([['fcm']]);
});

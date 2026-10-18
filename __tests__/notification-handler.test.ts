jest.mock('expo-notifications', () => ({}));
jest.mock('expo-constants', () => ({}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));

import { handleIncomingNotification, setAppForeground } from '@/xmpp/notifications';

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

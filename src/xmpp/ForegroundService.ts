import { NativeModules } from 'react-native';

const { XmppServiceModule } = NativeModules;

function startForegroundService(jid: string): Promise<void> {
  if (XmppServiceModule) {
    return XmppServiceModule.startService(jid).then(() => undefined);
  }
  return Promise.resolve();
}

function stopForegroundService(): Promise<void> {
  if (XmppServiceModule) {
    return XmppServiceModule.stopService().then(() => undefined);
  }
  return Promise.resolve();
}

function updateNotification(jid: string): Promise<void> {
  if (XmppServiceModule) {
    return XmppServiceModule.updateNotification(jid).then(() => undefined);
  }
  return Promise.resolve();
}

export const ForegroundService = {
  start: startForegroundService,
  stop: stopForegroundService,
  update: updateNotification,
};

import { NativeModules } from 'react-native';

const { XmppServiceModule } = NativeModules;

function startForegroundService(jid: string) {
  // Use Intent via NativeModules or a simple bridge
  // For now, we start via the native module
  if (XmppServiceModule) {
    XmppServiceModule.startService(jid);
  }
}

function stopForegroundService() {
  if (XmppServiceModule) {
    XmppServiceModule.stopService();
  }
}

function updateNotification(jid: string) {
  if (XmppServiceModule) {
    XmppServiceModule.updateNotification(jid);
  }
}

export const ForegroundService = {
  start: startForegroundService,
  stop: stopForegroundService,
  update: updateNotification,
};

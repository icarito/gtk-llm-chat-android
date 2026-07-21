package org.fuentelibre.gtk_llm_chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class XmppForegroundService extends Service {
    private static final String CHANNEL_ID = "xmpp_connection";
    private static final int NOTIFICATION_ID = 1;
    private static final String WAKE_LOCK_TAG = "gtk_llm_chat:xmpp_connection";

    // Doze/App Standby suspenden los timers del engine JS (el watchdog de ping
    // de XmppService.ts) con la pantalla apagada. Sin un wake lock parcial la
    // sesión XMPP se cae en silencio y nadie la reconecta hasta que el usuario
    // reabre la app. Se sostiene mientras dure la sesión, no por operación —
    // por eso no lleva timeout salvo el failsafe de más abajo.
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String jid = intent != null ? intent.getStringExtra("jid") : "Conectando...";
        String title = "gtk-llm-chat";
        String content = jid != null && !jid.isEmpty() ? "Conectado como " + jid : "Conectando...";

        Intent notificationIntent = new Intent(this, getMainActivityClass());
        notificationIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        startForeground(NOTIFICATION_ID, notification);
        acquireWakeLock();
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
        // Failsafe: si el servicio muere sin pasar por onDestroy (crash, kill
        // del sistema) el wake lock no debe sobrevivir indefinidamente y drenar
        // batería en segundo plano.
        wakeLock.acquire(12 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    public void updateNotification(String jid) {
        String content = "Conectado como " + jid;
        Intent notificationIntent = new Intent(this, getMainActivityClass());
        notificationIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("gtk-llm-chat")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIFICATION_ID, notification);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Conexión XMPP",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Notificación persistente de conexión XMPP");
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(channel);
        }
    }

    private Class<?> getMainActivityClass() {
        try {
            return Class.forName("org.fuentelibre.gtk_llm_chat.MainActivity");
        } catch (ClassNotFoundException e) {
            throw new RuntimeException(e);
        }
    }
}

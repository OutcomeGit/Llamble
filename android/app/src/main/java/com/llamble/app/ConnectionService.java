package com.llamble.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * "Stay connected in the background" (Settings → Notifications): a quiet "Llamble is
 * connected" notification that tells Android to keep Llamble running, so messages and
 * notifications keep arriving while you use other apps.
 */
public class ConnectionService extends Service {
    static volatile boolean running;

    static void start(Context c) {
        try {
            c.startForegroundService(new Intent(c, ConnectionService.class));
        } catch (Throwable ignored) {
            // Android only allows this while Llamble is on screen; the setting is re-applied next time it is
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ConnectionService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new Notification.Builder(this, Notify.CONNECTED)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Llamble is connected")
                .setContentText("Messages and notifications keep coming. Turn off in Settings → Notifications.")
                .setColor(0xff8ad13c)
                .setOngoing(true)
                .setContentIntent(Notify.open(this, null, false))
                .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        try {
            startForeground(8, n, type);
            running = true;
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

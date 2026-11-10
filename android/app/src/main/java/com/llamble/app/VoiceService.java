package com.llamble.app;

import android.Manifest;
import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * While you're in a voice channel: a "Llamble · in a call" notification that tells Android
 * to keep the app (and its microphone) running with the screen off or another app open.
 */
public class VoiceService extends Service {
    static volatile boolean running;
    private PowerManager.WakeLock lock;

    static void start(Context c, String title) {
        Intent i = new Intent(c, VoiceService.class).putExtra("title", title);
        try {
            c.startForegroundService(i);
        } catch (Throwable ignored) {
            // Android only allows this while the app is on screen; joining a call always is
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, VoiceService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra("title") : null;
        Notification n = new Notification.Builder(this, Notify.CALL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title == null || title.isEmpty() ? "In a voice call" : title)
                .setContentText("Tap to open Llamble")
                .setColor(0xff8ad13c)
                .setOngoing(true)
                .setContentIntent(Notify.open(this, null, false))
                .addAction(new Notification.Action.Builder(null, "Leave", Notify.open(this, null, true)).build())
                .build();
        // with the microphone allowed: a microphone call; without (listening only): just audio.
        // Android stops apps that claim the microphone without permission, so never guess.
        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK | (mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        try {
            startForeground(7, n, type);
        } catch (Exception e) {
            try {
                startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } catch (Exception e2) {
                // couldn't keep the call alive in the background; the call itself still works
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        running = true;
        if (lock == null) {
            lock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "llamble:voice");
            lock.acquire(6 * 60 * 60 * 1000L);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (lock != null && lock.isHeld()) lock.release();
        lock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

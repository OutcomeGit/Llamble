package com.llamble.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Notifications while Llamble is closed, without Google: one small connection to your own
 * Llamble server that only carries "you have a DM / @mention" notices (a few bytes every
 * few minutes in between). Runs on its own, so it keeps working after Llamble is swiped
 * away and starts again after the phone restarts. Off when Notifications are off in
 * Llamble's settings; steps aside while Llamble is on screen (the app shows them then).
 *
 * Android requires a "Listening for messages" notification for this; long-press it and
 * turn that category off to hide it. Listening carries on.
 */
public class ListenerService extends Service {
    static final String PREFS = "listener";
    static volatile boolean appVisible;
    private static volatile Thread loop;
    private static volatile HttpURLConnection current;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** The page tells us: on/off, and which server and login to listen with. */
    static void configure(Context c, boolean on, String server, String token) {
        SharedPreferences.Editor e = prefs(c).edit().putBoolean("on", on);
        if (server != null && !server.isEmpty()) e.putString("server", server);
        if (token != null && !token.isEmpty()) e.putString("token", token);
        if (!on && token == null) e.remove("token");
        e.apply();
        if (on) start(c);
        else c.stopService(new Intent(c, ListenerService.class));
    }

    static void start(Context c) {
        SharedPreferences p = prefs(c);
        if (!p.getBoolean("on", false) || p.getString("token", null) == null) return;
        try {
            c.startForegroundService(new Intent(c, ListenerService.class));
        } catch (Throwable ignored) {
            // only allowed while Llamble is open or right after the phone starts; tried again then
        }
    }

    /** Llamble came on screen / left it. */
    static void setAppVisible(boolean v) {
        appVisible = v;
        HttpURLConnection c = current;
        if (v && c != null) c.disconnect(); // the app has its own connection now
        Thread t = loop;
        if (!v && t != null) t.interrupt(); // reconnect now rather than after a back-off
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new Notification.Builder(this, Notify.LISTENING)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Listening for messages")
                .setContentText("Long-press to hide this. Llamble keeps listening.")
                .setOngoing(true)
                .setContentIntent(Notify.open(this, null, false))
                .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        try {
            startForeground(9, n, type);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (loop == null) {
            loop = new Thread(this::run, "llamble-listener");
            loop.start();
            ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).registerDefaultNetworkCallback(netBack);
        }
        return START_STICKY;
    }

    // back on a network: reconnect now
    private final ConnectivityManager.NetworkCallback netBack = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network network) {
            Thread t = loop;
            if (t != null) t.interrupt();
        }
    };

    private void run() {
        long wait = 2000;
        while (loop == Thread.currentThread()) {
            if (appVisible) {
                sleep(30_000);
                continue;
            }
            SharedPreferences p = prefs(this);
            String server = p.getString("server", null), token = p.getString("token", null);
            if (server == null || token == null || !p.getBoolean("on", false)) {
                stopSelf();
                return;
            }
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/notify/stream").openConnection();
                current = c;
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Accept", "text/event-stream");
                c.setConnectTimeout(20_000);
                c.setReadTimeout(7 * 60_000); // the server says something every 3 minutes
                int code = c.getResponseCode();
                if (code == 401) {
                    p.edit().remove("token").apply(); // signed out: stop until the app signs in again
                    stopSelf();
                    return;
                }
                if (code != 200) throw new Exception("HTTP " + code);
                wait = 2000;
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                    String line, event = null;
                    while ((line = r.readLine()) != null && !appVisible) {
                        if (line.startsWith("event:")) event = line.substring(6).trim();
                        else if (line.startsWith("data:") && "notify".equals(event)) show(line.substring(5).trim());
                        else if (line.isEmpty()) event = null;
                    }
                }
            } catch (Exception ignored) {
            } finally {
                current = null;
            }
            if (!appVisible) {
                sleep(wait);
                wait = Math.min(wait * 2, 5 * 60_000);
            }
        }
    }

    private void show(String data) {
        if (appVisible) return;
        try {
            JSONObject m = new JSONObject(data);
            Notify.message(this, m.optString("tag"), m.optString("title"), m.optString("body"), m.optString("channel_id"), m.isNull("guild_id") ? null : m.optString("guild_id"));
        } catch (Exception ignored) {
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    @Override
    public void onDestroy() {
        Thread t = loop;
        loop = null;
        if (t != null) t.interrupt();
        HttpURLConnection c = current;
        if (c != null) new Thread(c::disconnect).start();
        try {
            ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netBack);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

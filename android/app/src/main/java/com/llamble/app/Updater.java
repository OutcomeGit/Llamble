package com.llamble.app;

import android.app.AlertDialog;
import android.content.Context;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates, like the Windows app: looks at Llamble's latest GitHub release and, if it has a
 * newer Llamble.apk, offers it (downloaded in the browser; Android asks you to confirm the install).
 */
final class Updater {
    static final String LATEST = "https://api.github.com/repos/OutcomeGit/Llamble/releases/latest";
    static final String APK = "Llamble.apk";
    private static long lastCheck;
    private static String declined;
    private static boolean busy;

    static void check(MainActivity a, boolean manual) {
        long now = System.currentTimeMillis();
        if (busy || (!manual && now - lastCheck < 6 * 3600_000L)) return;
        lastCheck = now;
        busy = true;
        new Thread(() -> {
            try {
                JSONObject rel = new JSONObject(read(LATEST));
                String latest = rel.optString("tag_name").replaceFirst("^v", "");
                String url = null;
                JSONArray assets = rel.optJSONArray("assets");
                for (int i = 0; assets != null && i < assets.length(); i++)
                    if (APK.equals(assets.getJSONObject(i).optString("name")))
                        url = assets.getJSONObject(i).optString("browser_download_url");
                String mine = a.version();
                if (url == null || compare(latest, mine) <= 0) {
                    if (manual) a.runOnUiThread(() -> Toast.makeText(a, "Llamble is up to date (" + mine + ")", Toast.LENGTH_SHORT).show());
                    return;
                }
                a.bridge.send("update-available", "version", latest);
                if (!manual && latest.equals(declined)) return;
                final String apk = url;
                a.runOnUiThread(() -> {
                    if (a.isFinishing()) return;
                    new AlertDialog.Builder(a)
                            .setTitle("Update Llamble?")
                            .setMessage("Version " + latest + " is ready (you have " + mine + ").")
                            .setPositiveButton("Update", (d, w) -> install(a, apk))
                            .setNegativeButton("Later", (d, w) -> declined = latest)
                            .show();
                });
            } catch (Exception e) {
                if (manual) a.runOnUiThread(() -> Toast.makeText(a, "Couldn't check for updates", Toast.LENGTH_SHORT).show());
            } finally {
                busy = false;
            }
        }).start();
    }

    /** 0.1.89 vs 0.1.90 */
    static int compare(String x, String y) {
        String[] a = x.split("\\."), b = y.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int p = i < a.length ? num(a[i]) : 0, q = i < b.length ? num(b[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int num(String s) {
        try {
            return Integer.parseInt(s.replaceAll("\\D", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    private static String read(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        try (InputStream in = c.getInputStream()) {
            return new String(in.readAllBytes(), "UTF-8");
        }
    }

    /**
     * The new APK downloads in the browser and Android asks to install it. (The app doesn't
     * install anything itself: apps that can install other apps get flagged by Play Protect.)
     */
    private static void install(MainActivity a, String url) {
        Toast.makeText(a, "Downloading the update: tap it when it finishes to install", Toast.LENGTH_LONG).show();
        a.openOutside(url);
    }
}

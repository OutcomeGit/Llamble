package com.llamble.app;

import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates, like the Windows app: looks at Llamble's latest GitHub release and, if it has a
 * newer Llamble.apk, offers to install it. Android asks you to confirm the install.
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

    private static void install(MainActivity a, String url) {
        // Android needs "install unknown apps" allowed for Llamble once
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(a, "Allow Llamble to install updates, then come back", Toast.LENGTH_LONG).show();
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            lastCheck = 0;
            return;
        }
        Toast.makeText(a, "Downloading the update…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                PackageInstaller pi = a.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(a.getPackageName());
                int id = pi.createSession(p);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setInstanceFollowRedirects(true);
                    try (InputStream in = c.getInputStream(); OutputStream out = s.openWrite("llamble.apk", 0, c.getContentLengthLong())) {
                        in.transferTo(out);
                        s.fsync(out);
                    }
                    Intent done = new Intent(a, InstallResult.class);
                    PendingIntent pi2 = PendingIntent.getBroadcast(a, id, done, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    s.commit(pi2.getIntentSender());
                }
            } catch (Exception e) {
                a.runOnUiThread(() -> Toast.makeText(a, "Update failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }
}

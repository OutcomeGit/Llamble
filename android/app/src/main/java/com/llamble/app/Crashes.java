package com.llamble.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.widget.Toast;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.file.Files;

/**
 * If the app crashes, what happened is kept (on this phone only) and shown at the next
 * launch with a Copy button, so it can be pasted to whoever's fixing it.
 */
final class Crashes {
    private static boolean installed;

    static void install(Context c) {
        if (installed) return;
        installed = true;
        File f = new File(c.getFilesDir(), "last-crash.txt");
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try (PrintWriter w = new PrintWriter(new FileWriter(f))) {
                w.println("Llamble " + version(c) + " · Android " + Build.VERSION.RELEASE + " · " + Build.MANUFACTURER + " " + Build.MODEL);
                w.println("thread: " + t.getName());
                e.printStackTrace(w);
            } catch (Exception ignored) {
            }
            if (previous != null) previous.uncaughtException(t, e);
        });
    }

    /** not a crash of the app itself, but worth knowing (the page's own process died) */
    static void note(Context c, String what) {
        try (PrintWriter w = new PrintWriter(new FileWriter(new File(c.getFilesDir(), "last-crash.txt")))) {
            w.println("Llamble " + version(c) + " · Android " + Build.VERSION.RELEASE + " · " + Build.MANUFACTURER + " " + Build.MODEL);
            w.println(what);
        } catch (Exception ignored) {
        }
    }

    static void showLast(Activity a) {
        File f = new File(a.getFilesDir(), "last-crash.txt");
        if (!f.exists()) return;
        String text;
        try {
            text = new String(Files.readAllBytes(f.toPath()), "UTF-8");
        } catch (Exception e) {
            text = String.valueOf(e);
        }
        f.delete();
        final String report = text.length() > 6000 ? text.substring(0, 6000) : text;
        new AlertDialog.Builder(a)
                .setTitle("Llamble closed unexpectedly last time")
                .setMessage("Here's what happened, in case you want to send it along:\n\n" + (report.length() > 900 ? report.substring(0, 900) + "…" : report))
                .setPositiveButton("Copy details", (d, w) -> {
                    ((ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Llamble crash", report));
                    Toast.makeText(a, "Copied", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("Close", null)
                .show();
    }

    private static String version(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}

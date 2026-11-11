package com.llamble.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;

/**
 * The page and the app talk over a private message channel. After each page load the app hands
 * one end of it to the top page only (embedded frames never get it), and only to our own
 * address. Messages are JSON: the page sends {"cmd": ...}, the app sends {"event": ...}.
 * The page side is client/src/android.ts.
 */
final class Bridge {
    private final MainActivity app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebMessagePort port;
    // a file being saved in pieces (a recording from the Library)
    private Uri saving;
    private OutputStream savingOut;

    Bridge(MainActivity app) {
        this.app = app;
    }

    void connect(WebView web) {
        if (port != null) port.close();
        WebMessagePort[] ch = web.createWebMessageChannel();
        port = ch[0];
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort p, WebMessage m) {
                handle(m.getData());
            }
        });
        web.postWebMessage(new WebMessage("llamble-android", new WebMessagePort[]{ch[1]}), Uri.parse(MainActivity.ORIGIN));
        send("hello", "version", app.version());
    }

    /** send {"event": name, k1: v1, ...} to the page */
    void send(String event, Object... kv) {
        main.post(() -> {
            if (port == null) return;
            try {
                JSONObject o = new JSONObject().put("event", event);
                for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
                port.postMessage(new WebMessage(o.toString()));
            } catch (Exception ignored) {
            }
        });
    }

    private void handle(String data) {
        try {
            JSONObject m = new JSONObject(data);
            switch (m.optString("cmd")) {
                case "voice":
                    // in a call: keep running with the screen off; out: let Android rest
                    if (m.optBoolean("on")) VoiceService.start(app, m.optString("title", "In a voice call"));
                    else VoiceService.stop(app);
                    break;
                case "listener":
                    // notifications while closed: on/off, and the server + login to listen with
                    ListenerService.configure(app, m.optBoolean("on"), m.optString("server", null), m.has("token") ? m.optString("token") : null);
                    break;
                case "screen-start":
                    app.startScreenCapture(m.toString());
                    break;
                case "screen-stop":
                    ScreenService.stop(app);
                    break;
                case "screen-keyframe":
                    ScreenService.keyframe();
                    break;
                case "battery-settings":
                    app.startActivity(new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    break;
                case "notify":
                    Notify.message(app, m.optString("tag"), m.optString("title"), m.optString("body"));
                    break;
                case "notify-close":
                    Notify.cancel(app, m.optString("tag"));
                    break;
                case "open":
                    app.openOutside(m.optString("url"));
                    break;
                case "check-update":
                    Updater.check(app, true);
                    break;
                case "save-begin":
                    saveBegin(m.optString("name", "llamble-file"), m.optString("mime", "application/octet-stream"));
                    break;
                case "save-chunk":
                    if (savingOut != null) savingOut.write(Base64.decode(m.optString("b64"), Base64.DEFAULT));
                    break;
                case "save-end":
                    saveEnd(m.optBoolean("ok", true));
                    break;
            }
        } catch (Exception e) {
            if (savingOut != null) saveEnd(false);
        }
    }

    /** Save into the phone's Downloads folder (no storage permission needed on Android 10+). */
    private void saveBegin(String name, String mime) throws Exception {
        saveEnd(false);
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
        v.put(MediaStore.Downloads.MIME_TYPE, mime);
        v.put(MediaStore.Downloads.IS_PENDING, 1);
        ContentResolver cr = app.getContentResolver();
        saving = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        savingOut = saving == null ? null : cr.openOutputStream(saving);
        if (savingOut == null) throw new IllegalStateException("can't save");
    }

    private void saveEnd(boolean ok) {
        try {
            if (savingOut != null) savingOut.close();
        } catch (Exception ignored) {
        }
        savingOut = null;
        if (saving == null) return;
        ContentResolver cr = app.getContentResolver();
        if (ok) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(saving, v, null, null);
            main.post(() -> Toast.makeText(app, "Saved to Downloads", Toast.LENGTH_SHORT).show());
        } else {
            cr.delete(saving, null, null);
        }
        saving = null;
    }
}

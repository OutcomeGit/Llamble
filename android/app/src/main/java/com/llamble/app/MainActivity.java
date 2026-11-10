package com.llamble.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The whole app is the Llamble web app (bundled in assets/www) in a WebView, served from
 * Android's reserved https://appassets.androidplatform.net address so it counts as a secure
 * page (needed for the microphone and camera). It talks to whichever Llamble server you log
 * in to, exactly like the Windows app.
 *
 * The page and this app talk over a private message channel that only the top page gets
 * (not embedded frames such as video players), see {@link Bridge}.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    private static final int REQ_FILE = 1, REQ_PERM = 2, REQ_NOTIF = 3;

    /** the activity that's showing (for the voice notification's buttons and notification taps) */
    static MainActivity current;

    WebView web;
    Bridge bridge;
    private FrameLayout root;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Crashes.install(getApplicationContext());
        current = this;
        Notify.channels(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xff1e1f22);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfBars(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // a server on the home network may not have https
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " LlambleAndroid/" + version());
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        bridge = new Bridge(this);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, disposition, mime, length) -> download(url, disposition, mime));

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(ORIGIN + "/index.html");

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);

        Updater.check(this, false);
        Crashes.showLast(this);
        handleIntent(getIntent());
    }

    String version() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /** Android 15 draws apps under the status and navigation bars: pad the page clear of them (and the keyboard). */
    @SuppressWarnings("deprecation")
    private void keepClearOfBars(View v) {
        v.setOnApplyWindowInsetsListener((view, ins) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = ins.getInsets(WindowInsets.Type.ime());
                l = bars.left; t = bars.top; r = bars.right; b = Math.max(bars.bottom, ime.bottom);
            } else {
                l = ins.getSystemWindowInsetLeft(); t = ins.getSystemWindowInsetTop();
                r = ins.getSystemWindowInsetRight(); b = ins.getSystemWindowInsetBottom();
            }
            if (fullscreenView != null) { l = t = r = b = 0; }
            view.setPadding(l, t, r, b);
            return ins;
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    /** a tapped notification: tell the page which one (it opens that chat) */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String tag = intent.getStringExtra("notification");
        if (tag != null) bridge.send("notification-click", "tag", tag);
        if (intent.getBooleanExtra("leave_voice", false)) bridge.send("leave-voice");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = this;
        web.onResume();
        Updater.check(this, false);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // in a call the page must keep running (it's what sends and plays the audio)
        if (!VoiceService.running) web.onPause();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (isFinishing()) VoiceService.stop(this);
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            fullscreenCallback.onCustomViewHidden();
            return;
        }
        // let the page close an open window first; otherwise go to the background (keeps a call going)
        web.evaluateJavascript("window.llambleBack ? window.llambleBack() : false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    // ------------------------------------------------------------ downloads

    private void download(String url, String disposition, String mime) {
        if (!url.startsWith("http")) return; // blob: downloads are saved by the page through the bridge
        try {
            String name = URLUtil.guessFileName(url, disposition, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
            Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Couldn't download: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    void openOutside(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------ the page

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            if (HOST.equals(req.getUrl().getHost())) return false;
            openOutside(req.getUrl().toString()); // other sites open in the browser
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            return Assets.serve(MainActivity.this, u.getPath());
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            bridge.connect(web);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            // the page's process crashed or was killed for memory: start fresh, and say so once
            Crashes.note(MainActivity.this, detail.didCrash() ? "The page's process crashed (WebView)." : "Android stopped the page's process to free memory (WebView).");
            recreate();
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest req) {
            if (!HOST.equals(req.getOrigin().getHost())) {
                req.deny();
                return;
            }
            List<String> need = new ArrayList<>();
            for (String r : req.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) need.add(Manifest.permission.RECORD_AUDIO);
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) need.add(Manifest.permission.CAMERA);
            }
            List<String> missing = new ArrayList<>();
            for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
            if (missing.isEmpty()) {
                req.grant(req.getResources());
                return;
            }
            if (Build.VERSION.SDK_INT >= 31 && missing.contains(Manifest.permission.RECORD_AUDIO)) missing.add(Manifest.permission.BLUETOOTH_CONNECT);
            if (pendingPermission != null) pendingPermission.deny();
            pendingPermission = req;
            requestPermissions(missing.toArray(new String[0]), REQ_PERM);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback cb) {
            fullscreenView = view;
            fullscreenCallback = cb;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.requestApplyInsets();
        }

        @Override
        public void onHideCustomView() {
            if (fullscreenView != null) root.removeView(fullscreenView);
            fullscreenView = null;
            fullscreenCallback = null;
            root.requestApplyInsets();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_PERM || pendingPermission == null) return;
        PermissionRequest req = pendingPermission;
        pendingPermission = null;
        Map<String, Boolean> ok = new HashMap<>();
        for (int i = 0; i < perms.length; i++) ok.put(perms[i], results[i] == PackageManager.PERMISSION_GRANTED);
        List<String> grant = new ArrayList<>();
        for (String r : req.getResources()) {
            String p = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) ? Manifest.permission.RECORD_AUDIO
                    : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) ? Manifest.permission.CAMERA : null;
            if (p != null && (checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED || Boolean.TRUE.equals(ok.get(p)))) grant.add(r);
        }
        if (grant.isEmpty()) req.deny();
        else req.grant(grant.toArray(new String[0]));
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != REQ_FILE || fileCallback == null) return;
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                picked = new Uri[n];
                for (int i = 0; i < n; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }
}

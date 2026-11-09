package com.llamble.app;

import android.content.Context;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceResponse;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/** Serves the bundled web app (assets/www) at https://appassets.androidplatform.net/. */
final class Assets {
    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("gif", "image/gif");
        TYPES.put("webp", "image/webp");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("mp3", "audio/mpeg");
        TYPES.put("ogg", "audio/ogg");
        TYPES.put("wav", "audio/wav");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("tflite", "application/octet-stream");
        TYPES.put("binarypb", "application/octet-stream");
    }

    static WebResourceResponse serve(Context ctx, String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return notFound();
        String file = "www" + path;
        InputStream in = open(ctx, file);
        // the web app's own pages (no file extension) all load index.html
        if (in == null && !path.substring(path.lastIndexOf('/') + 1).contains(".")) {
            file = "www/index.html";
            in = open(ctx, file);
        }
        if (in == null) return notFound();
        String ext = file.substring(file.lastIndexOf('.') + 1).toLowerCase();
        String mime = TYPES.get(ext);
        if (mime == null) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null) mime = "application/octet-stream";
        WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("json") ? "utf-8" : null, in);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", "*");
        r.setResponseHeaders(h);
        return r;
    }

    private static InputStream open(Context ctx, String file) {
        try {
            return ctx.getAssets().open(file);
        } catch (IOException e) {
            return null;
        }
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }
}

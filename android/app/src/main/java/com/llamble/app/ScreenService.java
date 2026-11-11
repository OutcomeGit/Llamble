package com.llamble.app;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;

import org.json.JSONObject;

import java.nio.ByteBuffer;

/**
 * Screen sharing from the phone: Android's own screen capture (you pick the whole screen or
 * one app in Android's prompt), encoded to H.264 on the phone's video chip, plus the shared
 * apps' sound. Each piece goes to the web page, which shares it in the call (phonescreen.ts).
 * Android shows its own "sharing" indicator the whole time; stopping from there works too.
 */
public class ScreenService extends Service {
    static volatile ScreenService live;

    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaCodec encoder;
    private AudioRecord sound;
    private volatile boolean running;

    static void start(Context c, int code, Intent data, String want) {
        Intent i = new Intent(c, ScreenService.class).putExtra("code", code).putExtra("data", data).putExtra("want", want);
        try {
            c.startForegroundService(i);
        } catch (Throwable e) {
            send("screen-denied", "reason", "Android didn't allow screen sharing to start");
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ScreenService.class));
    }

    /** the page's decoder needs a full picture (it restarted) */
    static void keyframe() {
        ScreenService s = live;
        if (s == null || s.encoder == null) return;
        Bundle b = new Bundle();
        b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try {
            s.encoder.setParameters(b);
        } catch (Exception ignored) {
        }
    }

    private static void send(String event, Object... kv) {
        MainActivity a = MainActivity.current;
        if (a != null) a.bridge.send(event, kv);
    }

    @Override
    @SuppressWarnings("deprecation")
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null || running) return START_NOT_STICKY;
        Notification n = new Notification.Builder(this, Notify.CALL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Sharing your screen in Llamble")
                .setColor(0xff8ad13c)
                .setOngoing(true)
                .setContentIntent(Notify.open(this, null, false))
                .addAction(new Notification.Action.Builder(null, "Stop sharing",
                        PendingIntent.getService(this, 3, new Intent(this, ScreenService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)).build())
                .build();
        try {
            startForeground(10, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            projection = mpm.getMediaProjection(intent.getIntExtra("code", 0), intent.getParcelableExtra("data"));
            if (projection == null) throw new IllegalStateException("no projection");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopSelf(); // stopped from Android's own controls
                }
            }, new Handler(Looper.getMainLooper()));
            begin(new JSONObject(intent.getStringExtra("want")));
        } catch (Exception e) {
            send("screen-denied", "reason", "Screen sharing couldn't start: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
        live = this;
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private void begin(JSONObject want) throws Exception {
        // the phone's screen, scaled to fit what was asked for (e.g. 1920×1080), same shape
        DisplayMetrics dm = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
        int sw = dm.widthPixels, sh = dm.heightPixels;
        int longSide = Math.max(want.optInt("width", 1920), want.optInt("height", 1080));
        int shortSide = Math.min(want.optInt("width", 1920), want.optInt("height", 1080));
        int boxW = sw >= sh ? longSide : shortSide, boxH = sw >= sh ? shortSide : longSide;
        double k = Math.min(1.0, Math.min(boxW / (double) sw, boxH / (double) sh));
        int w = Math.max(16, ((int) Math.round(sw * k)) & ~15), h = Math.max(16, ((int) Math.round(sh * k)) & ~15);
        int fps = Math.max(10, Math.min(30, want.optInt("fps", 30)));

        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, Math.max(1_000_000, want.optInt("bitrate", 6_000_000)));
        f.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 1_000_000L / fps * 3); // a still screen keeps flowing
        f.setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1);
        f.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        f.setInteger(MediaFormat.KEY_PRIORITY, 0); // real time
        if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        encoder.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        Surface input = encoder.createInputSurface();
        encoder.start();
        display = projection.createVirtualDisplay("llamble-screen", w, h, dm.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null);
        running = true;
        new Thread(this::pumpVideo, "llamble-screen-video").start();

        // the shared apps' sound (games, videos, music; never the call itself)
        if (want.optBoolean("audio", true) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try {
                AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                        .addMatchingUsage(AudioAttributes.USAGE_GAME)
                        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                        .build();
                AudioFormat af = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
                sound = new AudioRecord.Builder().setAudioFormat(af).setBufferSizeInBytes(48000 * 4 / 5).setAudioPlaybackCaptureConfig(cfg).build();
                sound.startRecording();
                new Thread(this::pumpSound, "llamble-screen-sound").start();
            } catch (Exception e) {
                sound = null; // video still shares
            }
        }
    }

    private void pumpVideo() {
        MediaCodec.BufferInfo bi = new MediaCodec.BufferInfo();
        while (running) {
            int i;
            try {
                i = encoder.dequeueOutputBuffer(bi, 100_000);
            } catch (Exception e) {
                break;
            }
            if (i < 0) continue;
            try {
                ByteBuffer out = encoder.getOutputBuffer(i);
                if (out != null && bi.size > 0) {
                    byte[] b = new byte[bi.size];
                    out.position(bi.offset);
                    out.get(b);
                    boolean config = (bi.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                    boolean key = (bi.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                    send("screen-video", "b64", Base64.encodeToString(b, Base64.NO_WRAP), "config", config, "key", key, "ts", bi.presentationTimeUs);
                }
                encoder.releaseOutputBuffer(i, false);
            } catch (Exception e) {
                break;
            }
        }
    }

    private void pumpSound() {
        byte[] b = new byte[48000 * 4 / 50]; // 20 ms
        while (running && sound != null) {
            int n = sound.read(b, 0, b.length);
            if (n > 0) send("screen-audio", "b64", Base64.encodeToString(b, 0, n, Base64.NO_WRAP));
            else if (n < 0) break;
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        live = null;
        try {
            if (display != null) display.release();
        } catch (Exception ignored) {
        }
        try {
            if (encoder != null) {
                encoder.stop();
                encoder.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (sound != null) {
                sound.stop();
                sound.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (projection != null) projection.stop();
        } catch (Exception ignored) {
        }
        send("screen-stopped");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

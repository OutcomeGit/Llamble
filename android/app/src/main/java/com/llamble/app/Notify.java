package com.llamble.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/** Android notifications: messages and mentions (what the page would show in a browser), and the call. */
final class Notify {
    static final String MESSAGES = "messages", CALL = "call", UPDATES = "updates", LISTENING = "listening";

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel m = new NotificationChannel(MESSAGES, "Messages and mentions", NotificationManager.IMPORTANCE_HIGH);
        m.setDescription("Direct messages, @mentions and alarms");
        nm.createNotificationChannel(m);
        NotificationChannel call = new NotificationChannel(CALL, "Voice calls", NotificationManager.IMPORTANCE_LOW);
        call.setDescription("Shown while you're in a voice channel, so the call keeps going with the screen off");
        nm.createNotificationChannel(call);
        nm.createNotificationChannel(new NotificationChannel(UPDATES, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
        // Android requires this one while Llamble listens; turning it off hides it, listening carries on
        NotificationChannel conn = new NotificationChannel(LISTENING, "Listening for messages (you can turn this off)", NotificationManager.IMPORTANCE_MIN);
        conn.setDescription("Shown while Llamble listens for messages in the background. Turn it off to hide it: listening carries on.");
        conn.setShowBadge(false);
        nm.createNotificationChannel(conn);
    }

    static PendingIntent open(Context c, String tag, boolean leaveVoice) {
        return open(c, tag, leaveVoice, null, null);
    }

    static PendingIntent open(Context c, String tag, boolean leaveVoice, String channelId, String guildId) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (tag != null) i.putExtra("notification", tag);
        if (leaveVoice) i.putExtra("leave_voice", true);
        if (channelId != null && !channelId.isEmpty()) i.putExtra("open_channel", channelId);
        if (guildId != null) i.putExtra("open_guild", guildId);
        int code = (tag == null ? 0 : tag.hashCode()) + (leaveVoice ? 1 : 0);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void message(Context c, String tag, String title, String body) {
        message(c, tag, title, body, null, null);
    }

    /** a DM or @mention; the same tag twice (app and listener both saw it) shows once */
    static void message(Context c, String tag, String title, String body, String channelId, String guildId) {
        Notification n = new Notification.Builder(c, MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setColor(0xff8ad13c)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open(c, tag, false, channelId, guildId))
                .build();
        c.getSystemService(NotificationManager.class).notify(tag, 1, n);
    }

    static void cancel(Context c, String tag) {
        c.getSystemService(NotificationManager.class).cancel(tag, 1);
    }
}

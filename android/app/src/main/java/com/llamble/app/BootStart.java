package com.llamble.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After the phone restarts (or Llamble updates): start listening again, if it was on. */
public class BootStart extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        ListenerService.start(c);
    }
}

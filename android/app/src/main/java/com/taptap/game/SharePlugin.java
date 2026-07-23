package com.taptap.game;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Delivers a link shared into the app (Android ACTION_SEND) to the web layer.
 *
 * MainActivity captures the shared text from the launch/new intent and parks it
 * in the static field here; the web polls getSharedUrl() on launch and on every
 * resume, so one call covers a cold start (the share launched the app) and a
 * warm one (already open). Reading it clears it, so a link is consumed once.
 */
@CapacitorPlugin(name = "Share")
public class SharePlugin extends Plugin {
    private static String pending = null;

    /** Called by MainActivity when a share intent arrives. */
    static void setPending(String text) {
        pending = text;
    }

    @PluginMethod
    public void getSharedUrl(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", pending != null ? pending : "");
        pending = null; // consume once
        call.resolve(ret);
    }
}

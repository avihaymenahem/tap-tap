package com.taptap.game;

import android.content.Intent;
import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Show the splash. Must run before super.onCreate. On Android 12+ the
        // system splash is theme-driven; this call backports it to older phones
        // and applies postSplashScreenTheme once the WebView takes over.
        SplashScreen.installSplashScreen(this);
        // Local plugins must be registered before the bridge starts.
        registerPlugin(YoutubeDlPlugin.class);
        registerPlugin(SharePlugin.class);
        super.onCreate(savedInstanceState);
        // Cold start via the share sheet: the WebView is not loaded yet, so just
        // park the link; the web reads it once it mounts.
        handleShareIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Warm start (singleTask): a new share while the app is already running.
        setIntent(intent);
        handleShareIntent(intent);
    }

    private void handleShareIntent(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text != null && !text.isEmpty()) {
            SharePlugin.setPending(text);
        }
    }
}

package com.taptap.game;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.mapper.VideoInfo;

import java.io.File;

/**
 * The yt-dlp replacement, on device (PLAN.md §6h, MC1).
 *
 * Wraps youtubedl-android — the same yt-dlp the desktop pipeline shelled out to,
 * now bundled with its own Python + ffmpeg — behind two Capacitor methods that
 * mirror the old server's `fetchMetadata` and `downloadAudio`. Everything runs
 * on a worker thread: `init` extracts the Python runtime on first use and both
 * network calls are long. The heavy TS analysis is unchanged and lives in the
 * WebView worker (MA2); this only produces the m4a the analyzer decodes.
 */
@CapacitorPlugin(name = "YoutubeDl")
public class YoutubeDlPlugin extends Plugin {
    private boolean initialized = false;

    private synchronized void ensureInit() throws Exception {
        if (initialized) return;
        YoutubeDL.getInstance().init(getContext());
        FFmpeg.getInstance().init(getContext());
        // Pull the latest yt-dlp before the first download. The binary bundled in
        // the APK goes stale fast — YouTube changes its player constantly — and a
        // stale yt-dlp is the usual cause of "HTTP 403 Forbidden". Best-effort:
        // if the update can't reach GitHub, fall back to the bundled version.
        try {
            YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel.STABLE.INSTANCE);
        } catch (Exception ignored) {
            // Keep the bundled yt-dlp; a failed self-update must not block ingest.
        }
        initialized = true;
    }

    @PluginMethod
    public void fetchMetadata(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        new Thread(() -> {
            try {
                ensureInit();
                VideoInfo info = YoutubeDL.getInstance().getInfo(url);
                JSObject ret = new JSObject();
                ret.put("id", info.getId());
                ret.put("title", info.getTitle() != null ? info.getTitle() : "Unknown title");
                // Music uploads carry a real uploader; that is the artist fallback.
                ret.put("artist", info.getUploader() != null ? info.getUploader() : "");
                ret.put("duration", info.getDuration());
                ret.put("thumbnail", info.getThumbnail());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "metadata failed", e);
            }
        }).start();
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String destDir = call.getString("destDir");
        if (url == null || destDir == null) {
            call.reject("url and destDir are required");
            return;
        }
        new Thread(() -> {
            try {
                ensureInit();
                File dir = new File(destDir);
                dir.mkdirs();

                YoutubeDLRequest request = new YoutubeDLRequest(url);
                request.addOption("-x"); // extract audio only
                request.addOption("--audio-format", "m4a"); // bundled ffmpeg transcodes to AAC/m4a
                request.addOption("-o", new File(dir, "source.%(ext)s").getAbsolutePath());
                request.addOption("--write-thumbnail");
                request.addOption("--no-playlist");
                request.addOption("--no-warnings");

                // The plain overload — no per-line progress callback, whose
                // functional-interface arity has drifted between library versions.
                // The TS side still shows coarse stages ("Downloading…").
                YoutubeDL.getInstance().execute(request);

                String audioPath = null;
                String thumbnailPath = null;
                File[] files = dir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        String name = f.getName();
                        if (!name.startsWith("source.")) continue;
                        String ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase();
                        if (ext.equals("jpg") || ext.equals("jpeg") || ext.equals("png") || ext.equals("webp")) {
                            thumbnailPath = f.getAbsolutePath();
                        } else {
                            audioPath = f.getAbsolutePath();
                        }
                    }
                }
                if (audioPath == null) {
                    call.reject("yt-dlp produced no audio file");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("audioPath", audioPath);
                if (thumbnailPath != null) ret.put("thumbnailPath", thumbnailPath);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "download failed", e);
            }
        }).start();
    }
}

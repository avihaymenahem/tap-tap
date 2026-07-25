# Releasing the Android APK

The shipped artifact is a **sideload APK** (personal use only — never the Play
Store; see CLAUDE.md). It is built **arm64-v8a only** (the S25), which roughly
halves the download vs. shipping every ABI.

## One-time: create a release signing key

A release APK must be signed. Generate a keystore **once** and keep it safe — if
you lose it you can't ship an update that upgrades an already-installed build.

```bash
keytool -genkeypair -v \
  -keystore android/app/taptap-release.jks \
  -alias taptap \
  -keyalg RSA -keysize 2048 -validity 10000
```

It will prompt for a keystore password, your name/org, and a key password. Then
create **`android/keystore.properties`** (gitignored — never commit it):

```properties
storeFile=taptap-release.jks
storePassword=<the keystore password you chose>
keyAlias=taptap
keyPassword=<the key password you chose>
```

`storeFile` is resolved relative to `android/app/`. Both the `.jks` and
`keystore.properties` are gitignored.

When `keystore.properties` is absent (fresh clone, CI), the build still works —
it just falls back to the debug-signed `assembleDebug`.

## Cut a release

1. Bump `version` in `package.json` and `versionCode`/`versionName` in
   `android/app/build.gradle`.
2. `npm test && npx tsc -b` — green.
3. `npm run build:android` (web build + `cap sync`).
4. Build the APK:
   - **Signed release** (keystore present): `cd android && ./gradlew assembleRelease`
     → `android/app/build/outputs/apk/release/app-release.apk`
   - **Debug** (no keystore): `cd android && ./gradlew assembleDebug`
     → `android/app/build/outputs/apk/debug/app-debug.apk`
5. Rename to `taptap-vX.Y.Z.apk`, commit, push `main` + tag `vX.Y.Z`.
6. `gh release create vX.Y.Z <apk> --title "…" --notes-file <notes>`.

## Notes

- **`minifyEnabled` is off on purpose.** youtubedl-android reaches its bundled
  Python runtime and ffmpeg through JNI/reflection; R8 would strip them and
  break ingest, and that can't be verified without the physical device. The size
  win is arm64-only, not code shrinking.
- The **release** build is not `debuggable`, so ART optimizes it — it runs a bit
  faster than the debug build (relevant to the 60fps invariant), on top of being
  properly signed.

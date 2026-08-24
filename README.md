# ZeeKay Power

ZeeKay Power is the Cloudflare-hosted home power dashboard and its companion Android app.

## Android app

The Android app lives in `android/` and loads the production dashboard only from
`https://power.zeekayeditz.com`. Authentication is passed to background monitoring through an
origin-restricted WebView message channel and stored with Android Keystore AES-GCM encryption.
It never uses a JavaScript interface or stores the account password.

Notification options include:

- WAPDA/grid availability changes
- Relay and Units Lock changes
- Automatic battery-shift start and finish
- Low-battery warnings with an adjustable threshold
- Stale monitor data and background check failures

Android schedules background status checks every 15 minutes, the minimum reliable interval
supported by WorkManager. The dashboard itself continues to refresh live while the app is open.

### Build

Install JDK 17 and Android SDK Platform 36, then set `JAVA_HOME` and `ANDROID_HOME` locally.

On Windows:

```powershell
cd android
.\gradlew.bat lintDebug assembleDebug
```

The installable development APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`. A public store release should be built with
an owner-controlled release keystore; keystores and signing properties are intentionally ignored
by Git.

## Cloudflare app

The Worker and static dashboard live in `api/`. The static shell includes an installable web app
manifest, offline shell cache, mobile navigation, safe-area support, and security headers. API
responses and credentials are never cached by the service worker.

```powershell
cd api
npm test
npx wrangler deploy --dry-run
```

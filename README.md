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

Personal passwordless APK builds receive a dedicated full-access device token through the
`ZEEKAY_APP_TOKEN` build environment. The plaintext token is never committed; Cloudflare stores
only its SHA-256 hash. The public website continues to require the normal account login.

## Units Lock accuracy and override

Units Lock can be switched on or off independently from auto-shift. Turning it off immediately
stops tracking and breaker enforcement, clears the active Units Lock session, and allows manual
WAPDA control. Turning it back on starts a fresh baseline from the current Tuya meter reading.

Manual Units Lock and relay requests are now persisted in a controller queue. If a poll or
relay operation is in progress, the API returns HTTP 202 with a `command_id`; the dashboard
waits for `/api/commands/:id` to report completion. The cron also drains the queue before
contacting SEMS and after releasing its controller lock. Unstarted commands expire after
three minutes. Interrupted relay commands are never replayed automatically. A manual ON
still requires Units Lock to be disabled and an online Tuya relay read-back to confirm ON.
Manual commands end an active auto-shift cycle, releasing its scheduled stop.

The nightly units calculation accepts exactly one source: the Tuya breaker's cumulative
`forward_energy_total` value. It does not use SEMS, inverter daily counters, instantaneous power,
or voltage × current estimates. This prevents battery/inverter output from being miscounted as
WAPDA units.

## WAPDA availability and battery estimates

WAPDA voltage, current and power come only from the mains-side Tuya breaker. Each poll
also checks the device metadata's `online` flag, because Tuya's status endpoint can return
cached readings during a mains outage. Offline, failed or older-than-three-minute readings
are hidden; the panel says the meter is offline and availability is unverified. An online
meter with no mains voltage reports unavailable. Inverter output voltage is never mains
evidence. This assumes the Tuya meter senses the upstream WAPDA supply; software cannot
distinguish battery-fed voltage if the sensor is physically connected downstream instead.

The dashboard's calculated percentage is estimated usable reserve above the selected 45V
cutoff, not inverter SOC. The raw inverter `bms_soc` is unchanged. The internal chemical SOC
estimate still uses a 48V **140Ah** series bank, measured battery-side charging/discharging
power, charge efficiency, bounded resistance learning, and true-rest voltage anchors.
Rate-dependent discharge uses an assumed Peukert exponent of 1.12. Charging voltage alone
does not refill SOC; duplicate timestamps and gaps do not accumulate fictitious Ah, and a
cutoff voltage rebound does not restore usable reserve until measured charging occurs.

Backup time uses the owner's recorded 48.5V→45V night (520 minutes), with points at 47.7V
(340 minutes left), 47.3V (275), and 46.5V (135). The sharp lower knee is retained instead
of extrapolating the early slope. Runtime scales with a smoothed battery-side DC draw and
is capped by estimated remaining Ah. The reference 318.25W is a single observed sample,
not a measured overnight average, so runtime is explicitly low-confidence/approximate.
48.5V is not treated as full charge and 58Ah is not treated as the bank's total capacity.
Historic chart points retain their original meaning; new points use reserve to 45V.
These changes do not modify inverter cutoff, charging current, or charging voltage.

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

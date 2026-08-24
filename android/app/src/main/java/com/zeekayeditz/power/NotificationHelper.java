package com.zeekayeditz.power;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;

import org.json.JSONObject;

final class NotificationHelper {
    static final String CHANNEL_ALERTS = "power_alerts";
    static final String CHANNEL_STATUS = "dashboard_status";
    private static final String STATE_INITIALIZED = "status_initialized";
    private static final String LAST_GRID = "last_grid";
    private static final String LAST_RELAY = "last_relay";
    private static final String LAST_LOCK = "last_units_lock";
    private static final String LAST_AUTOSHIFT = "last_autoshift";
    private static final String LAST_STALE = "last_stale";
    private static final String LAST_SOC = "last_soc";
    private static final String FAILURE_COUNT = "failure_count";
    private static final String FAILURE_NOTIFIED = "failure_notified";
    private static final String SIGN_IN_NOTIFIED = "sign_in_notified";

    private NotificationHelper() {}

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel alerts = new NotificationChannel(
                CHANNEL_ALERTS,
                context.getString(R.string.notification_channel_alerts),
                NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription(context.getString(R.string.notification_channel_alerts_description));
        alerts.enableVibration(true);
        alerts.setLightColor(Color.rgb(55, 245, 181));
        alerts.enableLights(true);

        NotificationChannel status = new NotificationChannel(
                CHANNEL_STATUS,
                context.getString(R.string.notification_channel_status),
                NotificationManager.IMPORTANCE_DEFAULT);
        status.setDescription(context.getString(R.string.notification_channel_status_description));

        manager.createNotificationChannel(alerts);
        manager.createNotificationChannel(status);
    }

    static boolean notificationsEnabled(Context context) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager.areNotificationsEnabled();
    }

    static synchronized void processStatus(Context context, JSONObject status) {
        boolean grid = status.optBoolean("wapda_available", false);
        boolean relay = status.optBoolean("relay_state", false);
        boolean locked = status.optBoolean("unit_lock_locked", false);
        boolean autoshift = status.optBoolean("autoshift_charging", false);
        boolean stale = status.optBoolean("stale", true) || !status.optBoolean("data_available", true);
        double soc = status.optDouble("battery_soc", Double.NaN);

        android.content.SharedPreferences prefs = PreferenceStore.raw(context);
        if (!prefs.getBoolean(STATE_INITIALIZED, false)) {
            storeStatus(prefs, grid, relay, locked, autoshift, stale, soc);
            return;
        }

        boolean previousGrid = prefs.getBoolean(LAST_GRID, grid);
        boolean previousRelay = prefs.getBoolean(LAST_RELAY, relay);
        boolean previousLock = prefs.getBoolean(LAST_LOCK, locked);
        boolean previousAutoshift = prefs.getBoolean(LAST_AUTOSHIFT, autoshift);
        boolean previousStale = prefs.getBoolean(LAST_STALE, stale);
        float previousSoc = prefs.getFloat(LAST_SOC, Float.NaN);

        if (PreferenceStore.grid(context) && grid != previousGrid) {
            notify(context, 1101, "WAPDA " + (grid ? "is available" : "is unavailable"),
                    grid ? "Grid power has returned. Open ZeeKay Power for the live reading."
                            : "Grid power is no longer available. Cloud automation will keep monitoring it.", CHANNEL_ALERTS);
        }

        if (PreferenceStore.automation(context) && relay != previousRelay) {
            notify(context, 1102, "WAPDA relay turned " + (relay ? "ON" : "OFF"),
                    relay ? "The mains relay is now closed." : "The mains relay is now open.", CHANNEL_ALERTS);
        }

        if (PreferenceStore.automation(context) && locked && !previousLock) {
            notify(context, 1103, "Units Lock is active", "The nightly WAPDA limit was reached. WAPDA and auto-shift remain off until the lock releases.", CHANNEL_ALERTS);
        }

        if (PreferenceStore.automation(context) && autoshift != previousAutoshift) {
            notify(context, 1104, autoshift ? "Auto-shift charging started" : "Auto-shift charging ended",
                    autoshift ? "WAPDA was confirmed and the battery is charging through the automatic cycle."
                            : "The automatic WAPDA charging cycle has finished.", CHANNEL_ALERTS);
        }

        int threshold = PreferenceStore.batteryLevel(context);
        if (PreferenceStore.battery(context) && !Double.isNaN(soc)
                && !Float.isNaN(previousSoc) && previousSoc > threshold && soc <= threshold) {
            notify(context, 1105, "Battery is low", "Battery charge dropped to " + Math.round(soc) + "%. Open the dashboard to review WAPDA and auto-shift status.", CHANNEL_ALERTS);
        }

        if (PreferenceStore.automation(context) && stale && !previousStale) {
            notify(context, 1106, "Power data is delayed", "The dashboard has not received a fresh hardware sample. Background checks will continue.", CHANNEL_STATUS);
        }

        storeStatus(prefs, grid, relay, locked, autoshift, stale, soc);
        recordSuccess(context);
    }

    static synchronized void recordFailure(Context context) {
        android.content.SharedPreferences prefs = PreferenceStore.raw(context);
        int failures = prefs.getInt(FAILURE_COUNT, 0) + 1;
        boolean notified = prefs.getBoolean(FAILURE_NOTIFIED, false);
        prefs.edit().putInt(FAILURE_COUNT, failures).apply();
        if (failures >= 2 && !notified) {
            notify(context, 1201, "Background update unavailable", "ZeeKay Power could not reach the dashboard. It will try again automatically.", CHANNEL_STATUS);
            prefs.edit().putBoolean(FAILURE_NOTIFIED, true).apply();
        }
    }

    static synchronized void recordSuccess(Context context) {
        PreferenceStore.raw(context).edit()
                .putInt(FAILURE_COUNT, 0)
                .putBoolean(FAILURE_NOTIFIED, false)
                .putBoolean(SIGN_IN_NOTIFIED, false)
                .apply();
    }

    static synchronized void notifySignInRequired(Context context) {
        android.content.SharedPreferences prefs = PreferenceStore.raw(context);
        if (prefs.getBoolean(SIGN_IN_NOTIFIED, false)) return;
        notify(context, 1202, "Sign in to resume updates", "Your ZeeKay Power session expired. Open the app and sign in again.", CHANNEL_STATUS);
        prefs.edit().putBoolean(SIGN_IN_NOTIFIED, true).apply();
    }

    private static void storeStatus(android.content.SharedPreferences prefs, boolean grid, boolean relay,
                                    boolean locked, boolean autoshift, boolean stale, double soc) {
        android.content.SharedPreferences.Editor editor = prefs.edit()
                .putBoolean(STATE_INITIALIZED, true)
                .putBoolean(LAST_GRID, grid)
                .putBoolean(LAST_RELAY, relay)
                .putBoolean(LAST_LOCK, locked)
                .putBoolean(LAST_AUTOSHIFT, autoshift)
                .putBoolean(LAST_STALE, stale);
        if (!Double.isNaN(soc)) editor.putFloat(LAST_SOC, (float) soc);
        editor.apply();
    }

    private static void notify(Context context, int id, String title, String text, String channel) {
        if (!notificationsEnabled(context)) return;
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new Notification.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(Color.rgb(55, 245, 181))
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .build();
        context.getSystemService(NotificationManager.class).notify(id, notification);
    }
}

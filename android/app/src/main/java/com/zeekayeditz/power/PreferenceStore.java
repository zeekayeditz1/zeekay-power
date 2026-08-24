package com.zeekayeditz.power;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

final class PreferenceStore {
    private static final String FILE = "zk_power_preferences";
    private static final String GRID = "notify_grid";
    private static final String AUTOMATION = "notify_automation";
    private static final String BATTERY = "notify_battery";
    private static final String BATTERY_LEVEL = "notify_battery_level";

    private PreferenceStore() {}

    static SharedPreferences raw(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static boolean grid(Context context) {
        return raw(context).getBoolean(GRID, true);
    }

    static boolean automation(Context context) {
        return raw(context).getBoolean(AUTOMATION, true);
    }

    static boolean battery(Context context) {
        return raw(context).getBoolean(BATTERY, true);
    }

    static int batteryLevel(Context context) {
        return Math.max(10, Math.min(50, raw(context).getInt(BATTERY_LEVEL, 25)));
    }

    static void save(Context context, JSONObject preferences) {
        SharedPreferences.Editor editor = raw(context).edit();
        if (preferences.has("grid")) editor.putBoolean(GRID, preferences.optBoolean("grid", true));
        if (preferences.has("automation")) editor.putBoolean(AUTOMATION, preferences.optBoolean("automation", true));
        if (preferences.has("battery")) editor.putBoolean(BATTERY, preferences.optBoolean("battery", true));
        if (preferences.has("battery_level")) {
            int value = Math.max(10, Math.min(50, preferences.optInt("battery_level", 25)));
            editor.putInt(BATTERY_LEVEL, value);
        }
        editor.apply();
    }

    static JSONObject toJson(Context context) throws JSONException {
        return new JSONObject()
                .put("grid", grid(context))
                .put("automation", automation(context))
                .put("battery", battery(context))
                .put("battery_level", batteryLevel(context));
    }
}

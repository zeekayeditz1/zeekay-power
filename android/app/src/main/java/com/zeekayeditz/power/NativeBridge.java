package com.zeekayeditz.power;

import org.json.JSONObject;

final class NativeBridge {
    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    void handle(String rawMessage) {
        if (rawMessage == null || rawMessage.length() > 16_384) return;
        try {
            JSONObject message = new JSONObject(rawMessage);
            String type = message.optString("type", "");
            switch (type) {
                case "session": {
                    String token = message.optString("token", "");
                    SecureSessionStore.save(activity.getApplicationContext(), token);
                    StatusWorker.schedule(activity.getApplicationContext());
                    StatusWorker.runNow(activity.getApplicationContext());
                    sendState();
                    break;
                }
                case "logout":
                    SecureSessionStore.clear(activity.getApplicationContext());
                    sendState();
                    break;
                case "status": {
                    JSONObject status = message.optJSONObject("status");
                    if (status != null) NotificationHelper.processStatus(activity.getApplicationContext(), status);
                    break;
                }
                case "request_notifications":
                    activity.requestNotificationPermission();
                    break;
                case "save_preferences": {
                    JSONObject preferences = message.optJSONObject("preferences");
                    if (preferences != null) PreferenceStore.save(activity.getApplicationContext(), preferences);
                    sendState();
                    break;
                }
                case "get_state":
                    sendState();
                    break;
                default:
                    break;
            }
        } catch (Exception ignored) {
            // Invalid bridge messages are ignored and never reach native APIs.
        }
    }

    void sendState() {
        try {
            JSONObject state = new JSONObject()
                    .put("native", true)
                    .put("notifications_enabled", NotificationHelper.notificationsEnabled(activity))
                    .put("background_interval_minutes", 15)
                    .put("preferences", PreferenceStore.toJson(activity));
            activity.sendNativeEvent(state);
        } catch (Exception ignored) {
            // The page may be navigating; it will request state again after load.
        }
    }
}

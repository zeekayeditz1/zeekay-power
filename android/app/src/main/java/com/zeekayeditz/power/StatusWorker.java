package com.zeekayeditz.power;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

public final class StatusWorker extends Worker {
    private static final String STATUS_URL = "https://power.zeekayeditz.com/api/status";
    private static final String PERIODIC_NAME = "zeekay-power-background-status";
    private static final String IMMEDIATE_NAME = "zeekay-power-status-now";
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;

    public StatusWorker(@NonNull Context context, @NonNull WorkerParameters workerParameters) {
        super(context, workerParameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String token = SecureSessionStore.load(context);
        if (token == null || token.isBlank()) return Result.success();

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(STATUS_URL).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("User-Agent", "ZeekayPowerAndroid/1.0.0 BackgroundWorker");

            int code = connection.getResponseCode();
            if (code == 401) {
                SecureSessionStore.clear(context);
                NotificationHelper.notifySignInRequired(context);
                return Result.failure();
            }
            if (code < 200 || code >= 300) {
                NotificationHelper.recordFailure(context);
                return code >= 500 ? Result.retry() : Result.failure();
            }

            String body = readBounded(connection.getInputStream());
            JSONObject root = new JSONObject(body);
            JSONObject status = root.optJSONObject("status");
            if (status == null) status = root;
            NotificationHelper.processStatus(context, status);
            return Result.success();
        } catch (Exception ignored) {
            NotificationHelper.recordFailure(context);
            return Result.retry();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(StatusWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    static void runNow(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(StatusWorker.class)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE_NAME, ExistingWorkPolicy.REPLACE, request);
    }

    private static String readBounded(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Response too large");
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}

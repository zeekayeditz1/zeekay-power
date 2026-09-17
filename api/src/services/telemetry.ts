// GoodWe cloud hardware uploads are slower than the one-minute Worker poll.
// Keep the actual device time; tolerate an upload interval, never an outage.
export const SEMS_MAX_SAMPLE_AGE_S = 15 * 60;
export const BATTERY_MAX_SAMPLE_GAP_S = 15 * 60;

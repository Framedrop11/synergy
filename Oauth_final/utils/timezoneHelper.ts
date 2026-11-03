/**
 * timezoneHelper.ts — IANA timezone detection for the mobile app.
 *
 * Detects the device's local IANA timezone (e.g. "Asia/Kolkata") and provides
 * a fallback for environments where the Intl API may not return a full name.
 * The timezone is included when creating or editing reminders so the backend
 * can interpret daily recurrence in the correct local time across DST transitions.
 */

/**
 * Returns the device's IANA timezone string (e.g. "Asia/Kolkata").
 * Falls back to "UTC" if detection fails.
 */
export function getDeviceTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.length > 0 && tz !== 'undefined') return tz;
  } catch {
    // Intl not available
  }
  return 'UTC';
}

/**
 * Returns a short human-readable label for the current timezone,
 * suitable for showing in the UI (e.g. "IST +5:30" or "UTC").
 */
export function getTimezoneLabel(): string {
  try {
    const tz = getDeviceTimezone();
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    const h = Math.floor(abs / 60).toString().padStart(2, '0');
    const m = (abs % 60).toString().padStart(2, '0');
    // Derive short abbreviation from the Intl API
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date());
    const abbr = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    return abbr ? `${abbr} ${sign}${h}:${m}` : `UTC${sign}${h}:${m}`;
  } catch {
    return 'UTC';
  }
}

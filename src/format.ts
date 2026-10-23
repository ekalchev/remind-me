/**
 * Formats an instant for the commenter: their locale for the date and time
 * shapes, their zone for the wall clock, English for the relative phrase so
 * it reads naturally inside the app's English replies.
 */

import { DateTime, IANAZone } from 'luxon';

export const FALLBACK_ZONE = 'UTC';
export const FALLBACK_LOCALE = 'en-US';

export interface LocalTime {
  /** `9:00 AM CET` */
  time: string;
  /** `Fri, Oct 24, 2026` */
  date: string;
  /** `in 18 hours` */
  relative: string;
}

export function formatLocal(instant: Date, zone: string, locale: string, base: Date): LocalTime {
  const local = DateTime.fromJSDate(instant, { zone }).setLocale(locale);
  const zoneName = local.setLocale('en-US').toFormat('ZZZZ');
  return {
    // ICU puts a narrow no-break space (U+202F) before AM/PM, which some mail clients show as a box.
    time: `${local.toLocaleString(DateTime.TIME_SIMPLE).replace(/ /g, ' ')} ${zoneName}`,
    date: local.toLocaleString({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    // Luxon truncates toward zero, so a base 0.9 s past the minute would turn "in 10 minutes" into "in 9 minutes".
    relative: local.toRelative({ base: DateTime.fromJSDate(base, { zone }).startOf('second'), locale: 'en' }) ?? '',
  };
}

/** The user's IANA zone, or UTC when the profile hides it or it is unknown. */
export function resolveZone(timeZone: string | null | undefined): { zone: string; fallback: boolean } {
  if (timeZone && IANAZone.isValidZone(timeZone)) {
    return { zone: timeZone, fallback: false };
  }
  return { zone: FALLBACK_ZONE, fallback: true };
}

/** Jira reports locales as `en_US`; Intl wants `en-US`. */
export function resolveLocale(locale: string | null | undefined): string {
  const tag = (locale ?? '').replace(/_/g, '-');
  try {
    return tag && Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0 ? tag : FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** Jira timestamps look like `2026-10-23T09:15:02.123+0000`, which `Date` does not accept everywhere. */
export function parseJiraDate(value: string): Date {
  return new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

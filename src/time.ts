/**
 * Turns the arguments of `RemindMe! <when> [note]` into a due instant.
 *
 * Times are read relative to when the comment was written, in the
 * commenter's IANA time zone:
 *
 * - no time at all means one day later, as on Reddit;
 * - durations (`2 days`, `in 5 hours`, `3h30m`, `a week`) are parsed here,
 *   not by chrono: hours and minutes are exact elapsed time, while days,
 *   weeks, months and years keep the wall-clock time across a DST change;
 * - everything else (`tomorrow 9am`, `Friday`, `Oct 30 14:00`) goes to
 *   chrono, and the wall-clock fields it finds are re-anchored in the IANA
 *   zone, because chrono itself only knows fixed UTC offsets;
 * - a date without a time of day means 09:00, and a time already past today
 *   means tomorrow.
 *
 * The time expression must come first; whatever follows is the note, or, if
 * it contains a quoted string, the quoted string.
 */

import * as chrono from 'chrono-node';
import { DateTime, type DurationLikeObject } from 'luxon';

export const DEFAULT_HOUR = 9;
export const MAX_AHEAD_DAYS = 366;
export const MAX_NOTE_LENGTH = 500;

export type WhenResult =
  | { ok: true; dueAt: Date; note: string }
  | { ok: false; reason: 'unparsed' | 'past' | 'too-far' };

export function resolveWhen(args: string, createdAt: Date, zone: string): WhenResult {
  // Whole seconds, so "in 10 minutes" is exactly ten minutes after the second the comment was written.
  const reference = DateTime.fromJSDate(createdAt, { zone }).startOf('second');
  const trimmed = args.trim();

  if (trimmed === '' || isQuoted(trimmed)) {
    return finish(reference.plus({ days: 1 }), trimmed, reference);
  }

  const duration = parseDuration(trimmed);
  if (duration) {
    return finish(reference.plus(duration.value), trimmed.slice(duration.length), reference);
  }

  const parsed = chrono.parse(trimmed, { instant: createdAt, timezone: reference.offset }, { forwardDate: true })[0];
  if (!parsed || parsed.index !== 0) {
    return { ok: false, reason: 'unparsed' };
  }
  let due = anchorInZone(parsed, zone);
  if (!due.isValid) {
    return { ok: false, reason: 'unparsed' };
  }
  if (due <= reference && !parsed.start.isCertain('day') && !parsed.start.isCertain('weekday')) {
    due = due.plus({ days: 1 });
  }
  return finish(due, trimmed.slice(parsed.text.length), reference);
}

function finish(due: DateTime, rest: string, reference: DateTime): WhenResult {
  if (due <= reference) {
    return { ok: false, reason: 'past' };
  }
  if (due > reference.plus({ days: MAX_AHEAD_DAYS })) {
    return { ok: false, reason: 'too-far' };
  }
  return { ok: true, dueAt: due.toUTC().toJSDate(), note: extractNote(rest) };
}

const TIME_OF_DAY_WORDS = /\b(morning|afternoon|evening|tonight|night|noon|midday|midnight|lunch)\b/i;

function anchorInZone(parsed: chrono.ParsedResult, zone: string): DateTime {
  const start = parsed.start;
  if (start.isCertain('timezoneOffset')) {
    return DateTime.fromJSDate(parsed.date(), { zone });
  }
  const dateOnly = !start.isCertain('hour') && !start.isCertain('minute') && !TIME_OF_DAY_WORDS.test(parsed.text);
  return DateTime.fromObject(
    {
      year: start.get('year') ?? undefined,
      month: start.get('month') ?? undefined,
      day: start.get('day') ?? undefined,
      hour: dateOnly ? DEFAULT_HOUR : (start.get('hour') ?? DEFAULT_HOUR),
      minute: dateOnly ? 0 : (start.get('minute') ?? 0),
      second: dateOnly ? 0 : (start.get('second') ?? 0),
    },
    { zone },
  );
}

const UNITS: Array<[RegExp, keyof DurationLikeObject]> = [
  [/^(?:mo|mos|mon|mons|months?)$/i, 'months'],
  [/^(?:m|min|mins|minutes?)$/i, 'minutes'],
  [/^(?:h|hr|hrs|hours?)$/i, 'hours'],
  [/^(?:d|days?)$/i, 'days'],
  [/^(?:w|wk|wks|weeks?)$/i, 'weeks'],
  [/^(?:y|yr|yrs|years?)$/i, 'years'],
];

const DURATION_PART = /^(\d+(?:\.\d+)?|an?|one)\s*([a-z]+)(?:\s*,\s*|\s+and\s+|\s+)?/i;

/** Parses a leading duration such as `in 2 days`, `3h30m`, `1 week and 2 days`. */
export function parseDuration(text: string): { value: DurationLikeObject; length: number } | null {
  const lead = /^in\s+/i.exec(text);
  let position = lead ? lead[0].length : 0;
  const value: Record<string, number> = {};
  let parts = 0;

  for (;;) {
    const part = DURATION_PART.exec(text.slice(position));
    const unit = part ? unitOf(part[2] ?? '') : undefined;
    if (!part || !unit) {
      break;
    }
    const amount = /^\d/.test(part[1] ?? '') ? Number(part[1]) : 1;
    addAmount(value, unit, amount);
    position += part[0].length;
    parts++;
  }

  if (parts === 0 || !Object.values(value).some((amount) => amount > 0)) {
    return null;
  }
  const remainder = text.slice(position);
  if (remainder !== '' && !/^[\s"'“”,.:;-]/.test(text.slice(position - 1))) {
    return null;
  }
  return { value, length: position };
}

function unitOf(token: string): keyof DurationLikeObject | undefined {
  return UNITS.find(([pattern]) => pattern.test(token))?.[1];
}

/** Fractions of calendar units become hours, so `1.5 days` is 1 day and 12 hours. */
function addAmount(value: Record<string, number>, unit: keyof DurationLikeObject, amount: number): void {
  const whole = Math.trunc(amount);
  const fraction = amount - whole;
  value[unit] = (value[unit] ?? 0) + (unit === 'minutes' || unit === 'hours' ? amount : whole);
  if (fraction > 0 && unit !== 'minutes' && unit !== 'hours') {
    const hoursPerUnit: Record<string, number> = { days: 24, weeks: 168, months: 730, years: 8760 };
    value.hours = (value.hours ?? 0) + fraction * (hoursPerUnit[unit] ?? 0);
  }
}

function isQuoted(text: string): boolean {
  return /^["“'][^]*["”']$/.test(text);
}

export function extractNote(rest: string): string {
  const quoted = /["“]([^"”]+)["”]/.exec(rest);
  const note = quoted
    ? (quoted[1] ?? '')
    : rest
        .trim()
        .replace(/^[-:,.;–—]+\s*/, '')
        .replace(/^to\s+/i, '');
  return note.trim().slice(0, MAX_NOTE_LENGTH);
}

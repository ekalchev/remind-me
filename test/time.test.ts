import { describe, expect, it } from 'vitest';
import { parseDuration, resolveWhen } from '../src/time';

/** Resolves and returns the due instant as an ISO string, failing the test on an error result. */
function due(args: string, createdAtIso: string, zone: string): string {
  const result = resolveWhen(args, new Date(createdAtIso), zone);
  if (!result.ok) {
    throw new Error(`expected "${args}" to parse, got ${result.reason}`);
  }
  return result.dueAt.toISOString();
}

function note(args: string, createdAtIso = '2026-06-10T08:00:00Z', zone = 'Europe/Sofia'): string {
  const result = resolveWhen(args, new Date(createdAtIso), zone);
  if (!result.ok) {
    throw new Error(`expected "${args}" to parse, got ${result.reason}`);
  }
  return result.note;
}

function reason(args: string, createdAtIso = '2026-06-10T08:00:00Z', zone = 'Europe/Sofia'): string {
  const result = resolveWhen(args, new Date(createdAtIso), zone);
  return result.ok ? 'ok' : result.reason;
}

describe('durations', () => {
  const at = '2026-06-10T08:00:00Z';

  it.each([
    ['in 5 hours', '2026-06-10T13:00:00.000Z'],
    ['5 hours', '2026-06-10T13:00:00.000Z'],
    ['3h', '2026-06-10T11:00:00.000Z'],
    ['2h30m', '2026-06-10T10:30:00.000Z'],
    ['90 minutes', '2026-06-10T09:30:00.000Z'],
    ['an hour', '2026-06-10T09:00:00.000Z'],
    ['2 days', '2026-06-12T08:00:00.000Z'],
    ['1.5 days', '2026-06-11T20:00:00.000Z'],
    ['a week', '2026-06-17T08:00:00.000Z'],
    ['1 week and 2 days', '2026-06-19T08:00:00.000Z'],
    ['1 week, 2 days', '2026-06-19T08:00:00.000Z'],
    ['2 months', '2026-08-10T08:00:00.000Z'],
    ['in 1 year', '2027-06-10T08:00:00.000Z'],
  ])('%s', (args, expected) => {
    expect(due(args, at, 'Europe/Sofia')).toBe(expected);
  });

  it('defaults to one day when no time is given, as on Reddit', () => {
    expect(due('', at, 'Europe/Sofia')).toBe('2026-06-11T08:00:00.000Z');
    expect(due('"call the vendor"', at, 'Europe/Sofia')).toBe('2026-06-11T08:00:00.000Z');
    expect(note('"call the vendor"')).toBe('call the vendor');
  });

  it('does not take a clock time for a duration', () => {
    expect(parseDuration('5pm')).toBeNull();
    expect(parseDuration('10am tomorrow')).toBeNull();
  });

  it('does not take a word that merely starts with a unit', () => {
    expect(parseDuration('2 daysofthunder')).toBeNull();
  });
});

describe('notes', () => {
  it('is what follows the time', () => {
    expect(note('in 5 hours check if Sam replied')).toBe('check if Sam replied');
    expect(note('tomorrow 9am follow up with QA')).toBe('follow up with QA');
  });

  it('prefers a quoted string, Reddit style', () => {
    expect(note('2 days "check if Sam replied"')).toBe('check if Sam replied');
    expect(note('2 days “smart quotes”')).toBe('smart quotes');
  });

  it('drops a leading "to" and separators', () => {
    expect(note('tomorrow to call Sam')).toBe('call Sam');
    expect(note('3h - deploy window')).toBe('deploy window');
  });

  it('is empty when there is nothing after the time', () => {
    expect(note('2 days')).toBe('');
  });
});

describe('clock times in the commenter zone', () => {
  it('reads "tomorrow 9am" in each user zone', () => {
    const at = '2026-06-01T20:00:00Z';
    // Tokyo: it is already 2 June 05:00, so tomorrow is 3 June.
    expect(due('tomorrow 9am', at, 'Asia/Tokyo')).toBe('2026-06-03T00:00:00.000Z');
    // Los Angeles: still 1 June 13:00.
    expect(due('tomorrow 9am', at, 'America/Los_Angeles')).toBe('2026-06-02T16:00:00.000Z');
    // Kolkata has a half-hour offset.
    expect(due('tomorrow 9am', at, 'Asia/Kolkata')).toBe('2026-06-03T03:30:00.000Z');
  });

  it('rolls a time already past today over to tomorrow', () => {
    // 10:00 in Sofia (UTC+3).
    expect(due('9am', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-11T06:00:00.000Z');
    expect(due('5pm', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-10T14:00:00.000Z');
    expect(due('at 17:30', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-10T14:30:00.000Z');
  });

  it('puts a date without a time at 09:00', () => {
    // Wednesday 10 June 2026.
    expect(due('friday', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-12T06:00:00.000Z');
    expect(due('tomorrow', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-11T06:00:00.000Z');
    expect(due('June 20', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-20T06:00:00.000Z');
  });

  it('keeps a time-of-day word', () => {
    expect(due('tomorrow at noon', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2026-06-11T09:00:00.000Z');
  });

  it('takes a date with no year as the next one', () => {
    expect(due('Jan 5 10:00', '2026-06-10T07:00:00Z', 'Europe/Sofia')).toBe('2027-01-05T08:00:00.000Z');
  });

  it('honours an explicit zone in the text', () => {
    expect(due('tomorrow 9am UTC', '2026-06-10T07:00:00Z', 'Asia/Tokyo')).toBe('2026-06-11T09:00:00.000Z');
  });

  it('reads the time relative to when the comment was written, not when it is processed', () => {
    expect(due('in 10 minutes', '2026-01-01T00:00:00Z', 'UTC')).toBe('2026-01-01T00:10:00.000Z');
  });

  it('counts from the whole second the comment was written in', () => {
    expect(due('in 10 minutes', '2026-10-23T10:01:00.942Z', 'Europe/Sofia')).toBe('2026-10-23T10:11:00.000Z');
  });
});

describe('daylight saving time', () => {
  // Europe/Sofia leaves summer time on Sun 25 Oct 2026 at 04:00 EEST (UTC+3 -> UTC+2).
  const beforeFallBack = '2026-10-24T07:00:00Z'; // Sat 10:00 EEST

  it('keeps the wall clock for calendar units across the change', () => {
    expect(due('1 day', beforeFallBack, 'Europe/Sofia')).toBe('2026-10-25T08:00:00.000Z'); // Sun 10:00 EET
  });

  it('counts hours as elapsed time across the change', () => {
    expect(due('24 hours', beforeFallBack, 'Europe/Sofia')).toBe('2026-10-25T07:00:00.000Z'); // Sun 09:00 EET
  });

  it('anchors "tomorrow 9am" in the offset that applies tomorrow', () => {
    expect(due('tomorrow 9am', beforeFallBack, 'Europe/Sofia')).toBe('2026-10-25T07:00:00.000Z');
  });

  // America/New_York enters summer time on Sun 8 Mar 2026 at 02:00 EST (UTC-5 -> UTC-4).
  const beforeSpringForward = '2026-03-07T17:00:00Z'; // Sat 12:00 EST

  it('anchors a clock time after spring-forward in EDT', () => {
    expect(due('tomorrow 9am', beforeSpringForward, 'America/New_York')).toBe('2026-03-08T13:00:00.000Z');
  });

  it('moves a clock time inside the skipped hour forward', () => {
    expect(due('tomorrow 2:30am', beforeSpringForward, 'America/New_York')).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
  });

  it('keeps the wall clock for a week across the change', () => {
    expect(due('1 week', beforeSpringForward, 'America/New_York')).toBe('2026-03-14T16:00:00.000Z'); // Sat 12:00 EDT
  });
});

describe('errors', () => {
  it('reports text it cannot read as a time', () => {
    expect(reason('banana')).toBe('unparsed');
    expect(reason('check with Sam tomorrow')).toBe('unparsed');
  });

  it('reports a time in the past', () => {
    expect(reason('yesterday')).toBe('past');
    expect(reason('Jan 5 2025')).toBe('past');
  });

  it('rejects more than a year ahead', () => {
    expect(reason('2 years')).toBe('too-far');
    expect(reason('400 days')).toBe('too-far');
  });
});

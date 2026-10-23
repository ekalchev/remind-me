import { describe, expect, it } from 'vitest';
import { formatLocal, parseJiraDate, resolveLocale, resolveZone } from '../src/format';
import { cancelEmail, confirmationText, listEmail, reminderEmail } from '../src/messages';
import type { Reminder } from '../src/types';

describe('private command emails', () => {
  const base = 'https://example.atlassian.net';

  it('numbers the pending reminders in the order cancel uses', () => {
    const pending = [
      { dueAt: Date.parse('2026-10-24T07:00:00Z'), note: 'QA', zone: 'UTC', locale: 'en-US' },
      { dueAt: Date.parse('2026-10-25T07:00:00Z'), zone: 'UTC', locale: 'en-US' },
    ] as Reminder[];
    const email = listEmail('KAN-1', pending, new Date('2026-10-23T07:00:00Z'), base);
    expect(email.subject).toBe('Your reminders on KAN-1');
    expect(email.textBody).toContain('1. 7:00 AM UTC, Sat, Oct 24, 2026 (in 1 day) - QA');
    expect(email.textBody).toContain('2. 7:00 AM UTC, Sun, Oct 25, 2026 (in 2 days)\n');
    expect(email.textBody).toContain(`${base}/browse/KAN-1`);
  });

  it('says when there is nothing to list or cancel', () => {
    expect(listEmail('KAN-1', [], new Date(), base).textBody).toContain('You have no pending reminders on KAN-1.');
    expect(cancelEmail('KAN-1', 0, base, 3).textBody).toContain('no pending reminder number 3');
    expect(cancelEmail('KAN-1', 2, base).textBody).toContain('Cancelled 2 reminders on KAN-1.');
  });
});

describe('formatLocal', () => {
  it('formats in the user zone and locale, with the zone name', () => {
    const local = formatLocal(new Date('2026-10-24T07:00:00Z'), 'Europe/Berlin', 'en-US', new Date('2026-10-23T13:00:00Z'));
    expect(local.time).toBe('9:00 AM GMT+2');
    expect(local.date).toBe('Sat, Oct 24, 2026');
    expect(local.relative).toBe('in 18 hours');
  });

  it('uses the abbreviation where one exists', () => {
    const local = formatLocal(new Date('2026-12-01T14:00:00Z'), 'America/New_York', 'en-US', new Date('2026-11-30T14:00:00Z'));
    expect(local.time).toBe('9:00 AM EST');
  });

  it('follows the user locale for the date and time shape', () => {
    const local = formatLocal(new Date('2026-10-24T07:00:00Z'), 'Europe/Berlin', 'de-DE', new Date('2026-10-23T07:00:00Z'));
    expect(local.time).toBe('09:00 GMT+2');
    expect(local.date).toBe('Sa., 24. Okt. 2026');
  });

  it('does not round a whole duration down because of milliseconds', () => {
    const local = formatLocal(new Date('2026-10-23T10:11:00.000Z'), 'Europe/Sofia', 'en-US', new Date('2026-10-23T10:01:00.942Z'));
    expect(local.relative).toBe('in 10 minutes');
  });

  it('builds the confirmation sentence', () => {
    const local = formatLocal(new Date('2026-12-01T14:00:00Z'), 'America/New_York', 'en-US', new Date('2026-12-01T13:00:00Z'));
    expect(confirmationText(local)).toBe("I'll remind you at 9:00 AM EST, Tue, Dec 1, 2026 (in 1 hour).");
  });
});

describe('profile fallbacks', () => {
  it('falls back to UTC when the zone is hidden or unknown', () => {
    expect(resolveZone(null)).toEqual({ zone: 'UTC', fallback: true });
    expect(resolveZone('Mars/Olympus')).toEqual({ zone: 'UTC', fallback: true });
    expect(resolveZone('Europe/Sofia')).toEqual({ zone: 'Europe/Sofia', fallback: false });
  });

  it('converts Jira locales to BCP 47', () => {
    expect(resolveLocale('en_GB')).toBe('en-GB');
    expect(resolveLocale(null)).toBe('en-US');
    expect(resolveLocale('not a locale!')).toBe('en-US');
  });
});

describe('parseJiraDate', () => {
  it('accepts offsets without a colon', () => {
    expect(parseJiraDate('2026-10-23T09:15:02.123+0300').toISOString()).toBe('2026-10-23T06:15:02.123Z');
    expect(parseJiraDate('2026-10-23T09:15:02.123+0000').toISOString()).toBe('2026-10-23T09:15:02.123Z');
  });
});

describe('reminderEmail', () => {
  it('addresses the issue and escapes HTML', () => {
    const email = reminderEmail(
      { note: 'check <script>', commentId: '10042', createdAt: Date.parse('2026-10-23T07:00:00Z'), zone: 'UTC', locale: 'en-US' },
      { key: 'ABC-12', summary: 'Fix login & signup' },
      'https://example.atlassian.net',
    );
    expect(email.subject).toBe('Reminder: ABC-12 Fix login & signup');
    expect(email.textBody).toContain('Note: check <script>');
    expect(email.textBody).toContain('https://example.atlassian.net/browse/ABC-12?focusedCommentId=10042');
    expect(email.htmlBody).toContain('check &lt;script&gt;');
    expect(email.htmlBody).toContain('Fix login &amp; signup');
  });
});

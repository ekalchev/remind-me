import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../src/types';

const store = vi.hoisted(() => ({
  createReminder: vi.fn(async (_reminder: Reminder) => true),
  findPending: vi.fn(async (): Promise<Reminder[]> => []),
  replaceReminder: vi.fn(async (current: Reminder, next: Omit<Reminder, 'version'>) => ({ ...next, version: current.version + 1 })),
}));
const jira = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ accountId: 'user-1', timeZone: 'Europe/Sofia', locale: 'en_US' })),
}));
vi.mock('../src/store', () => store);
vi.mock('../src/jira', () => jira);

const { setReminderAction, listRemindersAction, cancelReminderAction, NO_ISSUE } = await import('../src/handlers/rovo');

const NOW = Date.parse('2026-10-23T10:00:00Z'); // Fri 13:00 in Sofia
const onIssue = { context: { jira: { issueId: '10001', issueKey: 'KAN-1' } } };
const asUser = { principal: { accountId: 'user-1' } };

function pending(overrides: Partial<Reminder>): Reminder {
  return {
    id: 'r-1',
    issueId: '10001',
    issueKey: 'KAN-1',
    accountId: 'user-1',
    dueAt: NOW + 3_600_000,
    createdAt: NOW,
    status: 'pending',
    attempts: 0,
    leaseUntil: 0,
    version: 0,
    zone: 'Europe/Sofia',
    locale: 'en-US',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  store.findPending.mockResolvedValue([]);
});

describe('setReminderAction', () => {
  it('stores a reminder in the user zone and reports the local time', async () => {
    const answer = await setReminderAction({ ...onIssue, when: 'tomorrow 9am', note: 'Check whether Sam replied' }, asUser);
    expect(store.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: '10001',
        issueKey: 'KAN-1',
        accountId: 'user-1',
        dueAt: Date.parse('2026-10-24T06:00:00Z'),
        note: 'Check whether Sam replied',
        zone: 'Europe/Sofia',
        status: 'pending',
      }),
    );
    const stored = store.createReminder.mock.calls[0]![0];
    expect(stored.id).toMatch(/^r-[0-9a-f-]{36}$/);
    expect(stored.commentId).toBeUndefined();
    expect(answer).toContain('Reminder set on KAN-1 for 9:00 AM GMT+3, Sat, Oct 24, 2026');
    expect(answer).toContain('about: Check whether Sam replied');
  });

  it('takes the user from the invocation context, not from the payload', async () => {
    await setReminderAction({ context: { ...onIssue.context, accountId: 'someone-else' }, when: 'in 2 hours' }, asUser);
    expect(store.createReminder).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'user-1' }));
  });

  it('refuses an unreadable or past time without storing anything', async () => {
    expect(await setReminderAction({ ...onIssue, when: 'when the build is green' }, asUser)).toContain('could not be understood');
    expect(await setReminderAction({ ...onIssue, when: 'yesterday' }, asUser)).toContain('in the past');
    expect(store.createReminder).not.toHaveBeenCalled();
  });

  it('needs an open issue', async () => {
    expect(await setReminderAction({ when: 'in 2 hours' }, asUser)).toBe(NO_ISSUE);
    expect(store.createReminder).not.toHaveBeenCalled();
  });

  it('respects the per-issue limit', async () => {
    store.findPending.mockResolvedValue(Array.from({ length: 25 }, (_, i) => pending({ id: `r-${i}` })));
    expect(await setReminderAction({ ...onIssue, when: 'in 2 hours' }, asUser)).toContain('already has 25');
    expect(store.createReminder).not.toHaveBeenCalled();
  });

  it('says so when the profile hides the time zone', async () => {
    jira.getUser.mockResolvedValueOnce({ accountId: 'user-1', timeZone: null as unknown as string, locale: 'en_US' });
    expect(await setReminderAction({ ...onIssue, when: 'in 2 hours' }, asUser)).toContain('UTC');
  });
});

describe('listRemindersAction', () => {
  it('numbers the pending reminders', async () => {
    store.findPending.mockResolvedValue([pending({ note: 'QA' }), pending({ id: 'r-2', dueAt: NOW + 86_400_000 })]);
    const answer = await listRemindersAction(onIssue, asUser);
    expect(answer).toContain('1. 2:00 PM GMT+3, Fri, Oct 23, 2026 (in 1 hour) - QA');
    expect(answer).toContain('2. 1:00 PM GMT+3, Sat, Oct 24, 2026 (in 1 day)');
  });

  it('says when there are none', async () => {
    expect(await listRemindersAction(onIssue, asUser)).toBe('The user has no pending reminders on KAN-1.');
  });
});

describe('cancelReminderAction', () => {
  it('cancels one by its number', async () => {
    store.findPending.mockResolvedValue([pending({ id: 'r-1' }), pending({ id: 'r-2' })]);
    expect(await cancelReminderAction({ ...onIssue, number: 2 }, asUser)).toBe('Cancelled 1 reminder on KAN-1.');
    expect(store.replaceReminder).toHaveBeenCalledTimes(1);
    expect(store.replaceReminder.mock.calls[0]![0]).toMatchObject({ id: 'r-2' });
  });

  it('cancels all without a number', async () => {
    store.findPending.mockResolvedValue([pending({ id: 'r-1' }), pending({ id: 'r-2' })]);
    expect(await cancelReminderAction(onIssue, asUser)).toBe('Cancelled 2 reminders on KAN-1.');
  });

  it('reports a number that does not exist', async () => {
    expect(await cancelReminderAction({ ...onIssue, number: 3 }, asUser)).toContain('no pending reminder number 3');
  });
});

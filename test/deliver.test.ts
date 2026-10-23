import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../src/types';

const store = vi.hoisted(() => ({
  findClaimable: vi.fn(),
  replaceReminder: vi.fn(),
}));
const jira = vi.hoisted(() => ({
  getBaseUrl: vi.fn(async () => 'https://example.atlassian.net'),
  getIssue: vi.fn(),
  getComment: vi.fn(),
  notifyUser: vi.fn(),
}));
vi.mock('../src/store', () => store);
vi.mock('../src/jira', () => jira);

const { deliverDue, LEASE_MS, RETRY_DELAYS_MS } = await import('../src/handlers/deliver');

const NOW = Date.parse('2026-10-23T10:00:00Z');

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'c-1',
    issueId: '10001',
    issueKey: 'ABC-1',
    commentId: '1',
    accountId: 'user-1',
    dueAt: NOW - 60_000,
    note: 'check',
    createdAt: NOW - 3_600_000,
    status: 'pending',
    attempts: 0,
    leaseUntil: 0,
    version: 4,
    zone: 'UTC',
    locale: 'en-US',
    ...overrides,
  };
}

/** Makes replaceReminder behave like the real conditional write, recording what was written. */
function acceptWrites(): Array<Omit<Reminder, 'version'>> {
  const writes: Array<Omit<Reminder, 'version'>> = [];
  store.replaceReminder.mockImplementation(async (current: Reminder, next: Omit<Reminder, 'version'>) => {
    writes.push(next);
    return { ...next, version: current.version + 1 };
  });
  return writes;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  store.findClaimable.mockResolvedValue({ reminders: [reminder()] });
  jira.getIssue.mockResolvedValue({ key: 'ABC-1', summary: 'Login fails' });
  jira.notifyUser.mockResolvedValue(undefined);
  jira.getComment.mockResolvedValue({ id: '1', body: 'Waiting on QA. RemindMe! 2 hours', created: '', updated: '' });
});

describe('deliverDue', () => {
  it('claims, emails the one user, then marks the reminder sent', async () => {
    const writes = acceptWrites();
    await deliverDue();

    expect(writes[0]).toMatchObject({ status: 'pending', leaseUntil: NOW + LEASE_MS });
    expect(jira.notifyUser).toHaveBeenCalledWith(
      '10001',
      'user-1',
      expect.objectContaining({ subject: 'Reminder: ABC-1 Login fails', textBody: expect.stringContaining('"Waiting on QA."') }),
    );
    expect(writes[1]).toMatchObject({ status: 'sent', sentAt: NOW, attempts: 1 });
  });

  it('skips a reminder another run claimed first', async () => {
    store.replaceReminder.mockResolvedValue(null);
    await deliverDue();
    expect(jira.notifyUser).not.toHaveBeenCalled();
  });

  it('backs off after a failed email', async () => {
    const writes = acceptWrites();
    jira.notifyUser.mockRejectedValue(new Error('notify failed with 503'));
    await deliverDue();
    expect(writes[1]).toMatchObject({ status: 'pending', attempts: 1, leaseUntil: NOW + RETRY_DELAYS_MS[0]!, lastError: 'notify failed with 503' });
  });

  it('gives up after the last attempt', async () => {
    store.findClaimable.mockResolvedValue({ reminders: [reminder({ attempts: 2 })] });
    const writes = acceptWrites();
    jira.notifyUser.mockRejectedValue(new Error('boom'));
    await deliverDue();
    expect(writes[1]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('cancels a reminder whose issue was deleted', async () => {
    const writes = acceptWrites();
    jira.getIssue.mockResolvedValue(null);
    await deliverDue();
    expect(jira.notifyUser).not.toHaveBeenCalled();
    expect(writes[1]).toMatchObject({ status: 'cancelled', lastError: 'issue no longer exists' });
  });

  it('follows the cursor to later pages', async () => {
    acceptWrites();
    store.findClaimable
      .mockResolvedValueOnce({ reminders: [reminder({ id: 'c-1' })], cursor: 'next' })
      .mockResolvedValueOnce({ reminders: [reminder({ id: 'c-2' })] });
    await deliverDue();
    expect(store.findClaimable).toHaveBeenLastCalledWith(NOW, 'next');
    expect(jira.notifyUser).toHaveBeenCalledTimes(2);
  });
});

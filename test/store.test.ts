import { describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../src/types';

vi.mock('@forge/kvs', () => ({ default: {}, Filter: class {}, FilterConditions: {}, Sort: {}, WhereConditions: {} }));

const { storable } = await import('../src/store');

describe('storable', () => {
  it('leaves out empty and missing fields, which KVS refuses', () => {
    const reminder: Reminder = {
      id: 'c-1',
      issueId: '10001',
      issueKey: 'ABC-1',
      commentId: '1',
      accountId: 'user-1',
      dueAt: 1,
      note: '',
      createdAt: 0,
      sentAt: undefined,
      status: 'pending',
      attempts: 0,
      leaseUntil: 0,
      version: 0,
      zone: 'UTC',
      locale: 'en-US',
    };
    const stored = storable(reminder);
    expect(stored).not.toHaveProperty('note');
    expect(stored).not.toHaveProperty('sentAt');
    expect(stored).toMatchObject({ attempts: 0, leaseUntil: 0, version: 0, status: 'pending' });
  });
});

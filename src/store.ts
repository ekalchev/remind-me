/**
 * Reminder storage on the Forge KVS custom entity `reminder` (see manifest).
 *
 * Every change after creation is a conditional write that expects the
 * version it read, so two writers (an overlapping delivery run, a cancel
 * racing a delivery) cannot both win: the loser's transaction fails and it
 * moves on.
 */

import kvs, { Filter, FilterConditions, Sort, WhereConditions } from '@forge/kvs';
import type { Reminder } from './types';

export const ENTITY = 'reminder';
const BY_STATUS_DUE = 'by-status-due';
const BY_OWNER = 'by-issue-owner';

const reminders = () => kvs.entity<Reminder>(ENTITY);

export function reminderKey(commentId: string): string {
  return `c-${commentId}`;
}

export async function getReminder(id: string): Promise<Reminder | undefined> {
  return reminders().get(id);
}

/** Creates a reminder; false if one already exists for the comment (a re-delivered event). */
export async function createReminder(reminder: Reminder): Promise<boolean> {
  try {
    await reminders().set(reminder.id, storable(reminder), { keyPolicy: 'FAIL_IF_EXISTS' });
    return true;
  } catch (error) {
    if (await reminders().get(reminder.id)) {
      return false;
    }
    throw error;
  }
}

/**
 * Replaces `current` with `next` if nobody changed it since it was read.
 * Returns the stored reminder, or null when another writer got there first.
 */
export async function replaceReminder(current: Reminder, next: Omit<Reminder, 'version'>): Promise<Reminder | null> {
  const stored = storable({ ...next, version: current.version + 1 });
  try {
    await kvs
      .transact()
      .set(current.id, stored, {
        entityName: ENTITY,
        conditions: new Filter<Reminder>().and('version', FilterConditions.equalTo(current.version)),
      })
      .execute();
    return stored;
  } catch (error) {
    console.warn(`Conditional write of ${current.id} at version ${current.version} failed`, error);
    return null;
  }
}

/** The reminder without empty or missing fields, which KVS refuses to store. */
export function storable(reminder: Reminder): Reminder {
  return Object.fromEntries(
    Object.entries(reminder).filter(([, value]) => value !== undefined && value !== ''),
  ) as unknown as Reminder;
}

/** Pending reminders due by `now` that no run holds and no backoff delays, oldest first. */
export async function findClaimable(now: number, cursor?: string): Promise<{ reminders: Reminder[]; cursor?: string }> {
  let query = reminders()
    .query()
    .index(BY_STATUS_DUE, { partition: ['pending'] })
    .where(WhereConditions.lessThanEqualTo(now))
    .filters(new Filter<Reminder>().and('leaseUntil', FilterConditions.lessThanEqualTo(now)))
    .sort(Sort.ASC)
    .limit(50);
  if (cursor) {
    query = query.cursor(cursor);
  }
  const page = await query.getMany();
  return { reminders: page.results.map((result) => result.value), cursor: page.nextCursor };
}

/** A user's pending reminders on an issue, soonest first; the order `list` numbers them in. */
export async function findPending(issueId: string, accountId: string): Promise<Reminder[]> {
  const found: Reminder[] = [];
  let cursor: string | undefined;
  do {
    let query = reminders()
      .query()
      .index(BY_OWNER, { partition: [issueId, accountId, 'pending'] })
      .sort(Sort.ASC)
      .limit(100);
    if (cursor) {
      query = query.cursor(cursor);
    }
    const page = await query.getMany();
    found.push(...page.results.map((result) => result.value));
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

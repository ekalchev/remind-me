/**
 * Reminder operations shared by the comment trigger and the Rovo actions.
 */

import { findPending, replaceReminder } from './store';

export const MAX_PENDING_PER_ISSUE = 25;

/**
 * Cancels all of a user's pending reminders on an issue, or only the
 * `index`th in the order `list` numbers them (soonest first); returns how many.
 */
export async function cancelPending(issueId: string, accountId: string, index?: number): Promise<number> {
  const pending = await findPending(issueId, accountId);
  const targets = index === undefined ? pending : index >= 1 ? pending.slice(index - 1, index) : [];
  let cancelled = 0;
  for (const reminder of targets) {
    if (await replaceReminder(reminder, { ...reminder, status: 'cancelled', lastError: 'cancelled by user' })) {
      cancelled++;
    }
  }
  return cancelled;
}

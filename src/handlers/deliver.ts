/**
 * The five-minute scheduled trigger: emails every reminder that has come due.
 *
 * Delivery is at-least-once. A run claims a reminder by writing a lease
 * (`leaseUntil`) conditional on the version it read, so an overlapping or
 * duplicate run skips it; it then emails and marks it sent, again
 * conditionally. A run that dies between the email and the mark leaves the
 * lease to expire, and a later run sends again: a rare duplicate email
 * rather than a lost reminder.
 *
 * A failed email is retried on later runs after a backoff (held in the same
 * `leaseUntil`), and marked `failed` after the last attempt. A reminder whose
 * issue is gone is cancelled.
 */

import { adfToText } from '../adf';
import { commentContext } from '../command';
import { getBaseUrl, getComment, getIssue, notifyUser } from '../jira';
import { reminderEmail } from '../messages';
import { findClaimable, replaceReminder } from '../store';
import type { Reminder } from '../types';

export const LEASE_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000];

/** Must stay below the function's `timeoutSeconds` in manifest.yml, leaving room for the in-flight reminder. */
const RUN_BUDGET_MS = 100_000;

export async function deliverDue(): Promise<void> {
  const startedAt = Date.now();
  let baseUrl: string | undefined;
  let cursor: string | undefined;
  let sent = 0;

  do {
    const page = await findClaimable(Date.now(), cursor);
    for (const candidate of page.reminders) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        console.log(`Run budget spent after ${sent} reminders; the next run continues`);
        return;
      }
      const claimed = await replaceReminder(candidate, { ...candidate, leaseUntil: Date.now() + LEASE_MS });
      if (!claimed) {
        continue;
      }
      baseUrl ??= await getBaseUrl();
      if (await deliver(claimed, baseUrl)) {
        sent++;
      }
    }
    cursor = page.cursor;
  } while (cursor);

  if (sent > 0) {
    console.log(`Sent ${sent} reminders`);
  }
}

async function deliver(reminder: Reminder, baseUrl: string): Promise<boolean> {
  try {
    const issue = await getIssue(reminder.issueId);
    if (!issue) {
      await replaceReminder(reminder, { ...reminder, status: 'cancelled', lastError: 'issue no longer exists' });
      return false;
    }
    const comment = reminder.commentId ? await getComment(reminder.issueId, reminder.commentId) : null;
    const context = comment ? commentContext(adfToText(comment.body)) : '';
    await notifyUser(reminder.issueId, reminder.accountId, reminderEmail(reminder, issue, baseUrl, context));
    await replaceReminder(reminder, {
      ...reminder,
      issueKey: issue.key,
      status: 'sent',
      sentAt: Date.now(),
      attempts: reminder.attempts + 1,
    });
    return true;
  } catch (error) {
    await recordFailure(reminder, error);
    return false;
  }
}

async function recordFailure(reminder: Reminder, error: unknown): Promise<void> {
  const attempts = reminder.attempts + 1;
  const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  console.error(`Reminder ${reminder.id} attempt ${attempts} failed: ${lastError}`);
  const delay = RETRY_DELAYS_MS[attempts - 1];
  await replaceReminder(
    reminder,
    attempts >= MAX_ATTEMPTS || delay === undefined
      ? { ...reminder, status: 'failed', attempts, lastError }
      : { ...reminder, attempts, lastError, leaseUntil: Date.now() + delay },
  );
}

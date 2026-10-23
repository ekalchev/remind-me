export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

/**
 * One reminder, stored in the `reminder` custom entity. One set by a comment
 * is keyed `c-<commentId>`: a comment sets at most one reminder, so the key
 * also makes a re-delivered event a no-op and lets an edit find what it
 * replaces. One set through the Rovo agent has no comment and is keyed
 * `r-<uuid>`.
 *
 * Instants are epoch milliseconds held as `float`, because a KVS `integer` is
 * 32-bit. KVS rejects an empty string, so a field with no value (an empty
 * note) is left out of the stored value rather than written as `''`.
 */
export interface Reminder {
  id: string;
  issueId: string;
  issueKey: string;
  /** The comment that set it; absent for a reminder set through Rovo. */
  commentId?: string;
  accountId: string;
  dueAt: number;
  note?: string;
  createdAt: number;
  sentAt?: number;
  status: ReminderStatus;
  attempts: number;
  lastError?: string;
  /** Not before this instant may a delivery run claim the reminder: a claim's lease, or a retry's backoff. */
  leaseUntil: number;
  /** Bumped on every write; each conditional write expects the version it read. */
  version: number;
  zone: string;
  locale: string;
  confirmationCommentId?: string;
}

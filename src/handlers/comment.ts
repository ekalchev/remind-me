/**
 * Handles `avi:jira:commented:issue` (fired when a comment is created and
 * again on every edit) and `avi:jira:deleted:comment`.
 *
 * A comment sets at most one reminder. Editing the comment re-parses it and
 * moves the reminder, rewriting the app's confirmation in place rather than
 * posting another; editing the command away or deleting the comment cancels
 * it. `list`, `cancel` and `help` answer only the first version of a comment.
 */

import kvs from '@forge/kvs';
import { adfToText } from '../adf';
import { parseCommand, type Command } from '../command';
import { parseJiraDate, resolveLocale, resolveZone } from '../format';
import {
  addComment,
  getComment,
  getUser,
  replyTargetFor,
  updateComment,
  type JiraComment,
  type ReplyTarget,
} from '../jira';
import {
  cancelDoc,
  cancelledByDeleteDoc,
  cancelledByEditDoc,
  confirmationDoc,
  helpDoc,
  limitDoc,
  listDoc,
  rescheduledDoc,
  type Recipient,
} from '../messages';
import { createReminder, findPending, getReminder, reminderKey, replaceReminder } from '../store';
import { resolveWhen } from '../time';
import type { Reminder } from '../types';

export const MAX_PENDING_PER_ISSUE = 25;

/** A comment counts as edited once its update time moves this far past its creation. */
const EDIT_THRESHOLD_MS = 2_000;

export interface CommentEvent {
  selfGenerated?: boolean;
  atlassianId?: string;
  issue?: { id?: string; key?: string };
  comment?: { id?: string; author?: { accountId?: string } };
}

export async function onComment(event: CommentEvent): Promise<void> {
  const issueId = event.issue?.id;
  const commentId = event.comment?.id;
  if (event.selfGenerated || !issueId || !commentId) {
    return;
  }

  const comment = await getComment(issueId, commentId);
  const accountId = comment?.author?.accountId;
  if (!comment || !accountId || comment.author?.accountType === 'app') {
    return;
  }
  const command = parseCommand(adfToText(comment.body));
  const existing = await getReminder(reminderKey(commentId));
  if ((command.kind === 'none' && !existing) || !(await firstDeliveryOf(comment))) {
    return;
  }

  const user = await getUser(accountId);
  const { zone, fallback } = resolveZone(user?.timeZone);
  const recipient: Recipient = { accountId, displayName: user?.displayName ?? 'there' };
  const context: Context = {
    issueId,
    issueKey: event.issue?.key ?? issueId,
    comment,
    accountId,
    recipient,
    zone,
    zoneIsFallback: fallback,
    locale: resolveLocale(user?.locale),
    reply: replyTargetFor(issueId, comment),
  };

  if (existing) {
    await onEdit(context, command, existing);
    return;
  }
  const edited = isEdited(comment);
  switch (command.kind) {
    case 'set':
      await setReminder(context, command.args);
      break;
    case 'list':
      if (!edited) await addComment(context.reply, listDoc(recipient, context.issueKey, await findPending(issueId, accountId), new Date()));
      break;
    case 'cancel':
      if (!edited) await cancelReminders(context, command.index);
      break;
    case 'help':
      if (!edited) await addComment(context.reply, helpDoc(recipient, 'help'));
      break;
    case 'none':
      break;
  }
}

export interface CommentDeletedEvent {
  issue?: { id?: string };
  comment?: { id?: string };
}

export async function onCommentDeleted(event: CommentDeletedEvent): Promise<void> {
  const commentId = event.comment?.id;
  if (!commentId) {
    return;
  }
  const existing = await getReminder(reminderKey(commentId));
  if (!existing || existing.status !== 'pending') {
    return;
  }
  const cancelled = await replaceReminder(existing, { ...existing, status: 'cancelled', lastError: 'comment deleted' });
  if (cancelled && existing.confirmationCommentId) {
    await updateComment(existing.issueId, existing.confirmationCommentId, cancelledByDeleteDoc());
  }
}

interface Context {
  issueId: string;
  issueKey: string;
  comment: JiraComment;
  accountId: string;
  recipient: Recipient;
  zone: string;
  zoneIsFallback: boolean;
  locale: string;
  reply: ReplyTarget;
}

async function setReminder(context: Context, args: string): Promise<void> {
  const createdAt = parseJiraDate(context.comment.created);
  const when = resolveWhen(args, createdAt, context.zone);
  if (!when.ok) {
    await addComment(context.reply, helpDoc(context.recipient, when.reason));
    return;
  }
  if ((await findPending(context.issueId, context.accountId)).length >= MAX_PENDING_PER_ISSUE) {
    await addComment(context.reply, limitDoc(context.recipient, MAX_PENDING_PER_ISSUE));
    return;
  }

  const reminder: Reminder = {
    id: reminderKey(context.comment.id),
    issueId: context.issueId,
    issueKey: context.issueKey,
    commentId: context.comment.id,
    accountId: context.accountId,
    dueAt: when.dueAt.getTime(),
    note: when.note,
    createdAt: createdAt.getTime(),
    status: 'pending',
    attempts: 0,
    leaseUntil: 0,
    version: 0,
    zone: context.zone,
    locale: context.locale,
  };
  if (!(await createReminder(reminder))) {
    return;
  }
  const confirmationCommentId = await addComment(
    context.reply,
    confirmationDoc(context.recipient, reminder, createdAt, context.zoneIsFallback),
  );
  await replaceReminder(reminder, { ...reminder, confirmationCommentId });
}

async function onEdit(context: Context, command: Command, existing: Reminder): Promise<void> {
  if (existing.status !== 'pending') {
    return;
  }
  const confirmationId = existing.confirmationCommentId;
  const showOrReply = async (body: Parameters<typeof addComment>[1]) =>
    confirmationId ? updateComment(context.issueId, confirmationId, body) : void (await addComment(context.reply, body));

  if (command.kind !== 'set') {
    if (await replaceReminder(existing, { ...existing, status: 'cancelled', lastError: 'command removed by edit' })) {
      await showOrReply(cancelledByEditDoc(context.recipient));
    }
    return;
  }

  const editedAt = parseJiraDate(context.comment.updated);
  const when = resolveWhen(command.args, parseJiraDate(context.comment.created), context.zone);
  if (!when.ok) {
    if (await replaceReminder(existing, { ...existing, status: 'cancelled', lastError: `edit unparsed: ${when.reason}` })) {
      await showOrReply(helpDoc(context.recipient, when.reason));
    }
    return;
  }
  if (when.dueAt.getTime() === existing.dueAt && when.note === (existing.note ?? '')) {
    return;
  }
  const moved = await replaceReminder(existing, {
    ...existing,
    dueAt: when.dueAt.getTime(),
    note: when.note,
    attempts: 0,
    leaseUntil: 0,
    zone: context.zone,
    locale: context.locale,
  });
  if (moved) {
    await showOrReply(rescheduledDoc(context.recipient, moved, editedAt, context.zoneIsFallback));
  }
}

async function cancelReminders(context: Context, index?: number): Promise<void> {
  const pending = await findPending(context.issueId, context.accountId);
  const targets = index === undefined ? pending : index >= 1 ? pending.slice(index - 1, index) : [];
  let cancelled = 0;
  for (const reminder of targets) {
    if (await replaceReminder(reminder, { ...reminder, status: 'cancelled', lastError: 'cancelled by user' })) {
      cancelled++;
    }
  }
  await addComment(context.reply, cancelDoc(context.recipient, context.issueKey, cancelled, index));
}

function isEdited(comment: JiraComment): boolean {
  return parseJiraDate(comment.updated).getTime() - parseJiraDate(comment.created).getTime() > EDIT_THRESHOLD_MS;
}

/**
 * Forge may deliver an event more than once. One marker per comment version
 * (its update time) lets only the first delivery act; it expires after a day.
 */
async function firstDeliveryOf(comment: JiraComment): Promise<boolean> {
  const key = `seen:${comment.id}:${parseJiraDate(comment.updated).getTime()}`;
  try {
    await kvs.set(key, 1, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 1, unit: 'DAYS' } });
    return true;
  } catch (error) {
    if ((await kvs.get(key)) !== undefined) {
      return false;
    }
    throw error;
  }
}

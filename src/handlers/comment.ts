/**
 * Handles `avi:jira:commented:issue` (fired when a comment is created and
 * again on every edit) and `avi:jira:deleted:comment`.
 *
 * Only comments with the `RemindMe!` keyword are read, and only by the
 * parser: no AI is involved. Asking in plain words is the Rovo agent's job
 * (`handlers/rovo.ts`).
 *
 * A comment sets at most one reminder. Editing the comment re-reads it and
 * moves the reminder, rewriting the app's confirmation in place; editing the
 * keyword away or deleting the comment cancels it. List and cancel requests
 * answer only the first version of a comment, by email to the asker alone; a
 * command comment that held nothing else is then deleted.
 */

import kvs from '@forge/kvs';
import { adfToText } from '../adf';
import { commentContext, parseCommand, type Command } from '../command';
import { parseJiraDate, resolveLocale, resolveZone } from '../format';
import {
  addComment,
  deleteComment,
  getBaseUrl,
  getComment,
  getUser,
  notifyUser,
  replyTargetFor,
  updateComment,
  type JiraComment,
  type ReplyTarget,
} from '../jira';
import {
  cancelEmail,
  cancelledByDeleteDoc,
  cancelledByEditDoc,
  confirmationDoc,
  helpDoc,
  helpEmail,
  limitDoc,
  listEmail,
  rescheduledDoc,
  type Recipient,
  type ReminderEmail,
} from '../messages';
import { cancelPending, MAX_PENDING_PER_ISSUE } from '../reminders';
import { createReminder, findPending, getReminder, reminderKey, replaceReminder } from '../store';
import { resolveWhen, type WhenResult } from '../time';
import type { Reminder } from '../types';

/** A comment counts as edited once its update time moves this far past its creation. */
const EDIT_THRESHOLD_MS = 2_000;

/** What a comment asks for. */
type Request =
  | { kind: 'none' }
  | { kind: 'set'; when: WhenResult }
  | { kind: 'list' }
  | { kind: 'cancel'; index?: number }
  | { kind: 'help' };

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
  const text = adfToText(comment.body);
  const command = parseCommand(text);
  const existing = await getReminder(reminderKey(commentId));
  if (command.kind === 'none' && !existing) {
    return;
  }
  if (!(await firstDeliveryOf(comment))) {
    return;
  }

  const user = await getUser(accountId);
  const { zone, fallback } = resolveZone(user?.timeZone);
  const context: Context = {
    issueId,
    issueKey: event.issue?.key ?? issueId,
    comment,
    text,
    createdAt: parseJiraDate(comment.created),
    accountId,
    recipient: { accountId, displayName: user?.displayName ?? comment.author?.displayName ?? 'there' },
    zone,
    zoneIsFallback: fallback,
    locale: resolveLocale(user?.locale),
    reply: replyTargetFor(issueId, comment),
  };

  const request = readCommand(context, command);
  if (existing) {
    await onEdit(context, request, existing);
    return;
  }
  const edited = isEdited(comment);
  switch (request.kind) {
    case 'set':
      await setReminder(context, request.when);
      break;
    case 'list':
      if (!edited) {
        const pending = await findPending(issueId, accountId);
        await answerPrivately(context, listEmail(context.issueKey, pending, new Date(), await getBaseUrl()));
      }
      break;
    case 'cancel':
      if (!edited) {
        const cancelled = await cancelPending(issueId, accountId, request.index);
        await answerPrivately(context, cancelEmail(context.issueKey, cancelled, await getBaseUrl(), request.index));
      }
      break;
    case 'help':
      if (!edited) await answerPrivately(context, helpEmail(context.issueKey, await getBaseUrl()));
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
  text: string;
  createdAt: Date;
  accountId: string;
  recipient: Recipient;
  zone: string;
  zoneIsFallback: boolean;
  locale: string;
  reply: ReplyTarget;
}

/** What the keyword asks for, with its time resolved in the commenter's zone. */
function readCommand(context: Context, command: Command): Request {
  if (command.kind !== 'set') {
    return command.kind === 'none' ? { kind: 'none' } : command;
  }
  return { kind: 'set', when: resolveWhen(command.args, context.createdAt, context.zone) };
}

async function setReminder(context: Context, when: WhenResult): Promise<void> {
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
    createdAt: context.createdAt.getTime(),
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
    confirmationDoc(context.recipient, reminder, context.createdAt, context.zoneIsFallback),
  );
  await replaceReminder(reminder, { ...reminder, confirmationCommentId });
}

async function onEdit(context: Context, request: Request, existing: Reminder): Promise<void> {
  if (existing.status !== 'pending') {
    return;
  }
  const confirmationId = existing.confirmationCommentId;
  const showOrReply = async (body: Parameters<typeof addComment>[1]) =>
    confirmationId ? updateComment(context.issueId, confirmationId, body) : void (await addComment(context.reply, body));

  if (request.kind !== 'set') {
    if (await replaceReminder(existing, { ...existing, status: 'cancelled', lastError: 'request removed by edit' })) {
      await showOrReply(cancelledByEditDoc(context.recipient));
    }
    return;
  }

  const when = request.when;
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
    await showOrReply(rescheduledDoc(context.recipient, moved, parseJiraDate(context.comment.updated), context.zoneIsFallback));
  }
}

/** Emails the answer to the asker, then deletes their comment if it held nothing but the command. */
async function answerPrivately(context: Context, email: ReminderEmail): Promise<void> {
  await notifyUser(context.issueId, context.accountId, email);
  if (commentContext(context.text) === '' && !(await deleteComment(context.issueId, context.comment.id))) {
    console.log(`Not allowed to delete command comment ${context.comment.id}; leaving it`);
  }
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

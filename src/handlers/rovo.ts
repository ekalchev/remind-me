/**
 * The Rovo agent's actions: set, list and cancel reminders on the issue the
 * user is viewing, asked for in plain words in Rovo chat.
 *
 * Rovo understands the request and calls these with structured inputs; the
 * time arrives as words (`tomorrow 9am`, `in 2 hours`) that the same parser
 * as the `RemindMe!` keyword resolves in the user's time zone. Each action
 * returns a short factual answer, which the agent phrases for the user. The
 * conversation is the user's own, so nothing is posted on the issue.
 */

import { randomUUID } from 'node:crypto';
import { formatLocal, resolveLocale, resolveZone } from '../format';
import { getUser } from '../jira';
import { cancelPending, MAX_PENDING_PER_ISSUE } from '../reminders';
import { createReminder, findPending } from '../store';
import { resolveWhen } from '../time';
import type { Reminder } from '../types';

/** What Forge passes as an action's first argument: its inputs, plus where it was invoked. */
export interface ActionPayload {
  when?: string;
  note?: string;
  number?: number;
  context?: {
    accountId?: string;
    jira?: { issueId?: string; issueKey?: string };
  };
}

/** The invocation context, the action's second argument; the user is its `principal`. */
export interface ActionContext {
  principal?: { accountId?: string };
}

export const NO_ISSUE =
  'No Jira issue is open. Ask the user to open the issue they want to be reminded about and ask again from there.';

export async function setReminderAction(payload: ActionPayload, context?: ActionContext): Promise<string> {
  const target = targetOf(payload, context);
  if (typeof target === 'string') {
    return target;
  }
  const words = (payload.when ?? '').trim();
  const now = new Date();
  const { zone, locale, fallback } = await profileOf(target.accountId);
  const when = resolveWhen(words, now, zone);
  if (!when.ok) {
    const why: Record<typeof when.reason, string> = {
      unparsed: `The time "${words}" could not be understood.`,
      past: `The time "${words}" is in the past.`,
      'too-far': `The time "${words}" is more than a year ahead.`,
    };
    return `${why[when.reason]} Not set. Ask the user for a time such as "in 2 hours", "tomorrow 9am", "Friday 14:00" or "Oct 30 5pm".`;
  }
  if ((await findPending(target.issueId, target.accountId)).length >= MAX_PENDING_PER_ISSUE) {
    return `Not set: the user already has ${MAX_PENDING_PER_ISSUE} pending reminders on ${target.issueKey}. They can cancel some first.`;
  }

  const note = (payload.note ?? '').trim().slice(0, 500) || when.note;
  const reminder: Reminder = {
    id: `r-${randomUUID()}`,
    issueId: target.issueId,
    issueKey: target.issueKey,
    accountId: target.accountId,
    dueAt: when.dueAt.getTime(),
    note,
    createdAt: now.getTime(),
    status: 'pending',
    attempts: 0,
    leaseUntil: 0,
    version: 0,
    zone,
    locale,
  };
  await createReminder(reminder);
  console.log(`Rovo set ${reminder.id} on ${target.issueKey} for ${when.dueAt.toISOString()} from "${words}"`);
  const local = formatLocal(when.dueAt, zone, locale, now);
  return [
    `Reminder set on ${target.issueKey} for ${local.time}, ${local.date} (${local.relative})${note ? `, about: ${note}` : ''}.`,
    'It will arrive by email, up to about 5 minutes late.',
    fallback ? "The user's time zone is hidden in their Atlassian profile, so the time is in UTC; tell them." : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function listRemindersAction(payload: ActionPayload, context?: ActionContext): Promise<string> {
  const target = targetOf(payload, context);
  if (typeof target === 'string') {
    return target;
  }
  const pending = await findPending(target.issueId, target.accountId);
  console.log(`Rovo listed ${pending.length} reminders on ${target.issueKey}`);
  if (pending.length === 0) {
    return `The user has no pending reminders on ${target.issueKey}.`;
  }
  const now = new Date();
  const lines = pending.map((reminder, index) => {
    const local = formatLocal(new Date(reminder.dueAt), reminder.zone, reminder.locale, now);
    return `${index + 1}. ${local.time}, ${local.date} (${local.relative})${reminder.note ? ` - ${reminder.note}` : ''}`;
  });
  return [
    `The user's pending reminders on ${target.issueKey}, numbered for cancelling:`,
    ...lines,
  ].join('\n');
}

export async function cancelReminderAction(payload: ActionPayload, context?: ActionContext): Promise<string> {
  const target = targetOf(payload, context);
  if (typeof target === 'string') {
    return target;
  }
  const index = Number.isInteger(payload.number) && (payload.number as number) > 0 ? (payload.number as number) : undefined;
  const cancelled = await cancelPending(target.issueId, target.accountId, index);
  console.log(`Rovo cancelled ${cancelled} reminders on ${target.issueKey}${index === undefined ? '' : ` (number ${index})`}`);
  if (cancelled === 0) {
    return index === undefined
      ? `The user had no pending reminders on ${target.issueKey}; nothing was cancelled.`
      : `There is no pending reminder number ${index} on ${target.issueKey}; nothing was cancelled. List them first.`;
  }
  return `Cancelled ${cancelled} reminder${cancelled === 1 ? '' : 's'} on ${target.issueKey}.`;
}

interface Target {
  issueId: string;
  issueKey: string;
  accountId: string;
}

/**
 * The issue and user the action is for. The user is taken from the invocation
 * context, never from an input, and the issue is the one they are viewing.
 */
function targetOf(payload: ActionPayload, context?: ActionContext): Target | string {
  const accountId = context?.principal?.accountId ?? payload.context?.accountId;
  const issueId = payload.context?.jira?.issueId;
  const issueKey = payload.context?.jira?.issueKey;
  if (!accountId) {
    return 'The user could not be identified, so nothing was done.';
  }
  if (!issueId || !issueKey) {
    console.warn(`Rovo action without an issue in its context: ${JSON.stringify(payload.context ?? {})}`);
    return NO_ISSUE;
  }
  return { issueId: String(issueId), issueKey, accountId };
}

async function profileOf(accountId: string): Promise<{ zone: string; locale: string; fallback: boolean }> {
  const user = await getUser(accountId);
  const { zone, fallback } = resolveZone(user?.timeZone);
  return { zone, locale: resolveLocale(user?.locale), fallback };
}

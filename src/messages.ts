/**
 * The app's replies, as ADF documents, and the reminder email.
 */

import type { AdfNode } from './adf';
import { formatLocal, type LocalTime } from './format';
import type { Reminder } from './types';

export interface Recipient {
  accountId: string;
  displayName: string;
}

export const EXAMPLES = [
  'RemindMe! 2 days',
  'RemindMe! in 5 hours "check if Sam replied"',
  'RemindMe! tomorrow 9am',
  'RemindMe! Friday 14:00 follow up',
  'RemindMe! list',
  'RemindMe! cancel 2',
];

export function confirmationDoc(
  to: Recipient,
  reminder: Pick<Reminder, 'dueAt' | 'note' | 'zone' | 'locale'>,
  setAt: Date,
  zoneIsFallback: boolean,
): AdfNode {
  const local = formatLocal(new Date(reminder.dueAt), reminder.zone, reminder.locale, setAt);
  const parts: AdfNode[] = [mention(to), text(` ${confirmationText(local)}`)];
  if (reminder.note) {
    parts.push(text(' Note: '), text(reminder.note, 'em'));
  }
  if (reminder.dueAt - setAt.getTime() < 10 * 60_000) {
    parts.push(text(' Reminders are checked every 5 minutes, so it may arrive a few minutes late.'));
  }
  if (zoneIsFallback) {
    parts.push(text(" I can't see your time zone in your Atlassian profile, so times are in UTC."));
  }
  return doc(paragraph(...parts));
}

export function confirmationText(local: LocalTime): string {
  return `I'll remind you at ${local.time}, ${local.date} (${local.relative}).`;
}

export function rescheduledDoc(
  to: Recipient,
  reminder: Pick<Reminder, 'dueAt' | 'note' | 'zone' | 'locale'>,
  editedAt: Date,
  zoneIsFallback: boolean,
): AdfNode {
  const updated = confirmationDoc(to, reminder, editedAt, zoneIsFallback);
  updated.content?.[0]?.content?.splice(1, 0, text(' (updated)'));
  return updated;
}

export function cancelledByEditDoc(to: Recipient): AdfNode {
  return doc(paragraph(mention(to), text(' Your reminder was cancelled because the comment no longer contains a RemindMe! command.')));
}

export function cancelledByDeleteDoc(): AdfNode {
  return doc(paragraph(text('This reminder was cancelled because its comment was deleted.')));
}

export function helpDoc(to: Recipient, reason: 'unparsed' | 'past' | 'too-far' | 'help'): AdfNode {
  const lead: Record<typeof reason, string> = {
    unparsed: " I couldn't work out when to remind you.",
    past: ' That time is already in the past.',
    'too-far': ' Reminders can be at most a year ahead.',
    help: ' Here is how to use me.',
  };
  return doc(
    paragraph(mention(to), text(`${lead[reason]} Put the time right after the keyword, and an optional note after it, for example:`)),
    {
      type: 'bulletList',
      content: EXAMPLES.map((example) => ({ type: 'listItem', content: [paragraph(text(example, 'code'))] })),
    },
    paragraph(text('A plain RemindMe! reminds you in one day. @remindme, !RemindMe and !remind work too.')),
  );
}

export function listDoc(to: Recipient, issueKey: string, pending: Reminder[], now: Date): AdfNode {
  if (pending.length === 0) {
    return doc(paragraph(mention(to), text(` You have no pending reminders on ${issueKey}.`)));
  }
  return doc(
    paragraph(mention(to), text(` Your pending reminders on ${issueKey}:`)),
    {
      type: 'orderedList',
      content: pending.map((reminder) => {
        const local = formatLocal(new Date(reminder.dueAt), reminder.zone, reminder.locale, now);
        const line = `${local.time}, ${local.date} (${local.relative})${reminder.note ? ` - ${reminder.note}` : ''}`;
        return { type: 'listItem', content: [paragraph(text(line))] };
      }),
    },
    paragraph(text('Cancel one with RemindMe! cancel <number>, or all with RemindMe! cancel.')),
  );
}

export function cancelDoc(to: Recipient, issueKey: string, cancelled: number, requestedIndex?: number): AdfNode {
  let message: string;
  if (requestedIndex !== undefined && cancelled === 0) {
    message = ` You have no pending reminder number ${requestedIndex} on ${issueKey}. Use RemindMe! list to see them.`;
  } else if (cancelled === 0) {
    message = ` You have no pending reminders on ${issueKey}.`;
  } else {
    message = ` Cancelled ${cancelled} reminder${cancelled === 1 ? '' : 's'} on ${issueKey}.`;
  }
  return doc(paragraph(mention(to), text(message)));
}

export function limitDoc(to: Recipient, limit: number): AdfNode {
  return doc(paragraph(mention(to), text(` You already have ${limit} pending reminders on this issue. Cancel some with RemindMe! cancel first.`)));
}

export interface ReminderEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export function reminderEmail(
  reminder: Pick<Reminder, 'note' | 'commentId' | 'createdAt' | 'zone' | 'locale'>,
  issue: { key: string; summary: string },
  baseUrl: string,
): ReminderEmail {
  const issueUrl = `${baseUrl}/browse/${encodeURIComponent(issue.key)}`;
  const commentUrl = `${issueUrl}?focusedCommentId=${encodeURIComponent(reminder.commentId)}`;
  const setAt = formatLocal(new Date(reminder.createdAt), reminder.zone, reminder.locale, new Date(reminder.createdAt));
  const lines = [
    `You asked to be reminded about ${issue.key}: ${issue.summary}`,
    ...(reminder.note ? ['', `Note: ${reminder.note}`] : []),
    '',
    `Open the issue: ${issueUrl}`,
    `Your comment from ${setAt.time}, ${setAt.date}: ${commentUrl}`,
  ];
  const html = [
    `<p>You asked to be reminded about <a href="${escapeHtml(issueUrl)}">${escapeHtml(issue.key)}: ${escapeHtml(issue.summary)}</a>.</p>`,
    ...(reminder.note ? [`<p><strong>Note:</strong> ${escapeHtml(reminder.note)}</p>`] : []),
    `<p><a href="${escapeHtml(commentUrl)}">Your comment from ${escapeHtml(`${setAt.time}, ${setAt.date}`)}</a></p>`,
  ];
  return {
    subject: `Reminder: ${issue.key} ${issue.summary}`,
    textBody: lines.join('\n'),
    htmlBody: html.join(''),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function doc(...content: AdfNode[]): AdfNode {
  return { version: 1, type: 'doc', content } as AdfNode;
}

function paragraph(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function text(value: string, mark?: 'em' | 'code'): AdfNode {
  return mark ? { type: 'text', text: value, marks: [{ type: mark }] } : { type: 'text', text: value };
}

function mention(to: Recipient): AdfNode {
  return { type: 'mention', attrs: { id: to.accountId, text: `@${to.displayName}` } };
}

/**
 * The Jira REST calls the app makes, all as the app itself.
 */

import { asApp, route } from '@forge/api';
import type { AdfNode } from './adf';
import type { ReminderEmail } from './messages';

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface JiraComment {
  id: string;
  body: unknown;
  created: string;
  updated: string;
  author?: { accountId?: string; accountType?: string };
  visibility?: { type: string; value?: string; identifier?: string };
  properties?: Array<{ key: string; value: unknown }>;
  jsdPublic?: boolean;
}

export interface JiraUser {
  accountId: string;
  accountType?: string;
  displayName?: string;
  timeZone?: string | null;
  locale?: string | null;
}

/** Where a reply goes and who may see it: the same audience as the comment it answers. */
export interface ReplyTarget {
  issueId: string;
  visibility?: JiraComment['visibility'];
  internal: boolean;
}

export async function getComment(issueId: string, commentId: string): Promise<JiraComment | null> {
  const response = await asApp().requestJira(
    route`/rest/api/3/issue/${issueId}/comment/${commentId}?expand=properties`,
    { headers: { Accept: 'application/json' } },
  );
  if (response.status === 404) {
    return null;
  }
  await ensureOk(response, 'get comment');
  return (await response.json()) as JiraComment;
}

export async function getUser(accountId: string): Promise<JiraUser | null> {
  const response = await asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`, {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    return null;
  }
  await ensureOk(response, 'get user');
  return (await response.json()) as JiraUser;
}

export async function getIssue(issueId: string): Promise<{ key: string; summary: string } | null> {
  const response = await asApp().requestJira(route`/rest/api/3/issue/${issueId}?fields=summary`, {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    return null;
  }
  await ensureOk(response, 'get issue');
  const issue = (await response.json()) as { key: string; fields?: { summary?: string } };
  return { key: issue.key, summary: issue.fields?.summary ?? '' };
}

export async function getBaseUrl(): Promise<string> {
  const response = await asApp().requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } });
  await ensureOk(response, 'get server info');
  const info = (await response.json()) as { baseUrl: string };
  return info.baseUrl.replace(/\/+$/, '');
}

export async function addComment(target: ReplyTarget, body: AdfNode): Promise<string> {
  const payload: Record<string, unknown> = { body };
  if (target.visibility) {
    payload.visibility = target.visibility;
  }
  if (target.internal) {
    payload.properties = [{ key: 'sd.public.comment', value: { internal: true } }];
  }
  const response = await asApp().requestJira(route`/rest/api/3/issue/${target.issueId}/comment`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await ensureOk(response, 'add comment');
  return ((await response.json()) as { id: string }).id;
}

export async function updateComment(issueId: string, commentId: string, body: AdfNode): Promise<void> {
  const response = await asApp().requestJira(route`/rest/api/3/issue/${issueId}/comment/${commentId}?notifyUsers=false`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (response.status === 404) {
    return;
  }
  await ensureOk(response, 'update comment');
}

/** Emails one user through Jira's notification queue. */
export async function notifyUser(issueId: string, accountId: string, email: ReminderEmail): Promise<void> {
  const response = await asApp().requestJira(route`/rest/api/3/issue/${issueId}/notify`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: email.subject,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
      to: { reporter: false, assignee: false, watchers: false, voters: false, users: [{ accountId }] },
    }),
  });
  await ensureOk(response, 'notify');
}

/** The audience of a comment, so a reply to a restricted or internal comment stays restricted or internal. */
export function replyTargetFor(issueId: string, comment: JiraComment): ReplyTarget {
  const internal =
    comment.jsdPublic === false ||
    comment.properties?.some(
      (property) => property.key === 'sd.public.comment' && (property.value as { internal?: boolean })?.internal === true,
    ) === true;
  return { issueId, visibility: comment.visibility, internal };
}

async function ensureOk(response: { ok: boolean; status: number; text(): Promise<string> }, what: string): Promise<void> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new JiraError(response.status, `${what} failed with ${response.status}: ${detail}`);
  }
}

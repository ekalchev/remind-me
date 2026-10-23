/**
 * Finds a RemindMe command in a comment's plain text.
 *
 * Accepted keywords, in any case: `RemindMe!`, `!RemindMe`, `@remindme` and
 * `!remind`. The keyword must stand on its own (not `foo@remindme`), only the
 * first occurrence counts, and its arguments run to the end of that line.
 */

export type Command =
  | { kind: 'none' }
  | { kind: 'set'; args: string }
  | { kind: 'list' }
  | { kind: 'cancel'; index?: number }
  | { kind: 'help' };

const KEYWORD = /(?<![\w@!])(?:remindme!|!remindme|@remindme|!remind)(?![\w!])/i;

export const MAX_CONTEXT_LENGTH = 300;

/**
 * The comment's text without the command itself (the keyword to the end of
 * its line), so a reminder email can show what the comment was about:
 * "Waiting on QA. RemindMe! tomorrow" is about "Waiting on QA.".
 */
export function commentContext(text: string): string {
  const match = KEYWORD.exec(text);
  const lineEnd = match ? text.indexOf('\n', match.index) : -1;
  const rest = match ? text.slice(0, match.index) + (lineEnd === -1 ? '' : text.slice(lineEnd)) : text;
  const context = rest.replace(/\s+/g, ' ').trim();
  return context.length > MAX_CONTEXT_LENGTH ? `${context.slice(0, MAX_CONTEXT_LENGTH - 1).trimEnd()}…` : context;
}

export function parseCommand(text: string): Command {
  const match = KEYWORD.exec(text);
  if (!match) {
    return { kind: 'none' };
  }
  const afterKeyword = text.slice(match.index + match[0].length);
  const args = (afterKeyword.split('\n')[0] ?? '').trim();

  const word = /^(\w+)\b\s*(.*)$/.exec(args);
  const verb = word?.[1]?.toLowerCase();
  const rest = word?.[2]?.trim() ?? '';

  if (verb === 'list' && rest === '') {
    return { kind: 'list' };
  }
  if (verb === 'help' && rest === '') {
    return { kind: 'help' };
  }
  if (verb === 'cancel') {
    if (rest === '' || /^all$/i.test(rest)) {
      return { kind: 'cancel' };
    }
    const index = /^#?(\d{1,3})$/.exec(rest);
    if (index) {
      return { kind: 'cancel', index: Number(index[1]) };
    }
    return { kind: 'help' };
  }
  return { kind: 'set', args };
}

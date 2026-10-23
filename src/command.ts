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

import { describe, expect, it } from 'vitest';
import { commentContext, parseCommand } from '../src/command';

describe('commentContext', () => {
  it('is the comment without the command line', () => {
    expect(commentContext('Waiting on QA. RemindMe! tomorrow')).toBe('Waiting on QA.');
    expect(commentContext('Deploy is blocked.\nRemindMe! 2 days\nSam owns the fix.')).toBe('Deploy is blocked. Sam owns the fix.');
  });

  it('is empty when the comment is only the command', () => {
    expect(commentContext('RemindMe! in 1 min')).toBe('');
  });

  it('is shortened with an ellipsis', () => {
    const context = commentContext(`${'word '.repeat(100)}RemindMe! 1 day`);
    expect(context.length).toBe(300);
    expect(context.endsWith('…')).toBe(true);
  });
});

describe('parseCommand', () => {
  it.each([
    ['RemindMe! 2 days', '2 days'],
    ['!RemindMe 2 days', '2 days'],
    ['@remindme in 5 hours check if Sam replied', 'in 5 hours check if Sam replied'],
    ['!remind tomorrow 9am', 'tomorrow 9am'],
    ['REMINDME! friday', 'friday'],
    ['remindme! friday', 'friday'],
  ])('recognises %s', (text, args) => {
    expect(parseCommand(text)).toEqual({ kind: 'set', args });
  });

  it('finds the keyword mid-sentence and reads to the end of that line only', () => {
    expect(parseCommand('Waiting on legal. RemindMe! 3 days "ping legal"\nThanks all')).toEqual({
      kind: 'set',
      args: '3 days "ping legal"',
    });
  });

  it('uses only the first occurrence', () => {
    expect(parseCommand('RemindMe! 1 day\nRemindMe! 2 days')).toEqual({ kind: 'set', args: '1 day' });
  });

  it('treats a bare keyword as a set with no time', () => {
    expect(parseCommand('RemindMe!')).toEqual({ kind: 'set', args: '' });
  });

  it.each(['foo@remindme 2 days', 'x!remind 2 days', 'remindme 2 days', '!reminder 2 days', '!remindmenow', 'no keyword here'])(
    'ignores %s',
    (text) => {
      expect(parseCommand(text)).toEqual({ kind: 'none' });
    },
  );

  it('parses list, help and cancel', () => {
    expect(parseCommand('RemindMe! list')).toEqual({ kind: 'list' });
    expect(parseCommand('@remindme LIST')).toEqual({ kind: 'list' });
    expect(parseCommand('RemindMe! help')).toEqual({ kind: 'help' });
    expect(parseCommand('RemindMe! cancel')).toEqual({ kind: 'cancel' });
    expect(parseCommand('RemindMe! cancel all')).toEqual({ kind: 'cancel' });
    expect(parseCommand('RemindMe! cancel 2')).toEqual({ kind: 'cancel', index: 2 });
    expect(parseCommand('RemindMe! cancel #3')).toEqual({ kind: 'cancel', index: 3 });
  });

  it('asks for help on a malformed cancel', () => {
    expect(parseCommand('RemindMe! cancel the meeting')).toEqual({ kind: 'help' });
  });

  it('treats "list" followed by more words as a time expression', () => {
    expect(parseCommand('RemindMe! list prices tomorrow')).toEqual({ kind: 'set', args: 'list prices tomorrow' });
  });
});

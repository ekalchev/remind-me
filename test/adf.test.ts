import { describe, expect, it } from 'vitest';
import { adfToText, type AdfNode } from '../src/adf';

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const t = (text: string, ...marks: string[]): AdfNode => ({
  type: 'text',
  text,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});

describe('adfToText', () => {
  it('puts each paragraph on its own line', () => {
    expect(adfToText(doc(p(t('Looks good.')), p(t('RemindMe! 2 days'))))).toBe('Looks good.\nRemindMe! 2 days');
  });

  it('joins marked text runs inside a paragraph', () => {
    expect(adfToText(doc(p(t('RemindMe! '), t('tomorrow', 'strong'), t(' 9am'))))).toBe('RemindMe! tomorrow 9am');
  });

  it('turns hard breaks into new lines', () => {
    expect(adfToText(doc(p(t('first'), { type: 'hardBreak' }, t('RemindMe! 1h'))))).toBe('first\nRemindMe! 1h');
  });

  it('drops code blocks, inline code, quotes and mentions', () => {
    const body = doc(
      p(t('Use '), t('RemindMe! 2 days', 'code'), t(' like this')),
      { type: 'codeBlock', content: [t('RemindMe! tomorrow')] },
      { type: 'blockquote', content: [p(t('RemindMe! friday'))] },
      p({ type: 'mention', attrs: { id: 'abc', text: '@remindme' } }, t(' hi')),
    );
    expect(adfToText(body)).toBe('Use like this\nhi');
  });

  it('reads nested lists, panels and table cells', () => {
    const body = doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('item one'))] }] },
      { type: 'panel', content: [p(t('!remind 3h'))] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('cell'))] }] }] },
    );
    expect(adfToText(body)).toBe('item one\n!remind 3h\ncell');
  });

  it('keeps emoji text and collapses non-breaking spaces', () => {
    expect(adfToText(doc(p(t('RemindMe!  2h '), { type: 'emoji', attrs: { shortName: ':+1:', text: '👍' } })))).toBe(
      'RemindMe! 2h 👍',
    );
  });

  it('passes a plain string body through and tolerates garbage', () => {
    expect(adfToText('RemindMe! 1 day')).toBe('RemindMe! 1 day');
    expect(adfToText(null)).toBe('');
    expect(adfToText({ nope: true })).toBe('');
  });
});

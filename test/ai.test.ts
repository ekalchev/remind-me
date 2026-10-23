import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/llm', () => ({ chat: vi.fn(), list: vi.fn() }));

const { toInterpretation, userMessage } = await import('../src/ai');
const { resolveWhen } = await import('../src/time');

describe('toInterpretation', () => {
  it('accepts a set with a time and a note', () => {
    expect(toInterpretation({ intent: 'set', when: 'in 2 hours', note: 'Check the build' })).toEqual({
      intent: 'set',
      when: 'in 2 hours',
      note: 'Check the build',
    });
  });

  it('accepts arguments delivered as a JSON string', () => {
    expect(toInterpretation('{"intent":"list"}')).toEqual({ intent: 'list' });
  });

  it('reads a set without a time as none', () => {
    expect(toInterpretation({ intent: 'set', note: 'x' })).toEqual({ intent: 'none' });
  });

  it('keeps a cancel index only when it is a positive integer', () => {
    expect(toInterpretation({ intent: 'cancel', index: 2 })).toEqual({ intent: 'cancel', index: 2 });
    expect(toInterpretation({ intent: 'cancel', index: 0 })).toEqual({ intent: 'cancel' });
    expect(toInterpretation({ intent: 'cancel', index: 'two' })).toEqual({ intent: 'cancel' });
  });

  it('reads anything malformed as none', () => {
    expect(toInterpretation(undefined)).toEqual({ intent: 'none' });
    expect(toInterpretation('not json')).toEqual({ intent: 'none' });
    expect(toInterpretation({ intent: 'delete everything' })).toEqual({ intent: 'none' });
  });
});

describe('userMessage', () => {
  it('gives the local time, the issue, earlier comments and the comment', () => {
    const message = userMessage({
      text: 'remind me tomorrow to check this',
      authorName: 'Emil "EK" Kalchev',
      createdAt: new Date('2026-10-23T10:00:00Z'),
      zone: 'Europe/Sofia',
      issueKey: 'KAN-1',
      issueSummary: 'Login fails',
      previous: [{ authorName: 'Sam', text: 'QA build is up' }],
    });
    expect(message).toContain('Friday 2026-10-23 13:00 in time zone Europe/Sofia');
    expect(message).toContain('Issue: KAN-1 Login fails');
    expect(message).toContain('<previous_comments>\nSam: QA build is up\n</previous_comments>');
    expect(message).toContain(`<comment author="Emil 'EK' Kalchev">\nremind me tomorrow to check this\n</comment>`);
  });
});

describe('the time forms the AI returns', () => {
  const at = new Date('2026-10-23T10:00:00Z'); // Fri 13:00 in Sofia

  it('resolves a duration', () => {
    const result = resolveWhen('in 1 days', at, 'Europe/Sofia');
    expect(result.ok && result.dueAt.toISOString()).toBe('2026-10-24T10:00:00.000Z');
  });

  it('resolves a local date and time in the author zone, across the DST change', () => {
    const result = resolveWhen('2026-10-26 09:00', at, 'Europe/Sofia');
    expect(result.ok && result.dueAt.toISOString()).toBe('2026-10-26T07:00:00.000Z'); // EET, UTC+2
  });

  it('rejects a local time in the past', () => {
    expect(resolveWhen('2026-10-22 09:00', at, 'Europe/Sofia')).toEqual({ ok: false, reason: 'past' });
  });
});

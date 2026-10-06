import { describe, expect, it } from 'vitest';
import { ago, isTerminal, ms, shortId, usd } from '../src/format.js';

describe('format helpers', () => {
  it('formats durations and money for small and large values', () => {
    expect(ms(850)).toBe('850 ms');
    expect(ms(2500)).toBe('2.50 s');
    expect(usd(0)).toBe('$0');
    expect(usd(0.000958)).toBe('$0.00096');
    expect(usd(0.5)).toBe('$0.5000');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(ago('2026-10-06T11:59:58Z', now)).toBe('just now');
    expect(ago('2026-10-06T11:59:00Z', now)).toBe('1 min ago');
    expect(ago('2026-10-06T09:00:00Z', now)).toBe('3 h ago');
  });

  it('knows which states are final', () => {
    expect(
      ['completed', 'failed', 'budget_exceeded', 'cancelled'].every((s) => isTerminal(s as never)),
    ).toBe(true);
    expect(['pending', 'running', 'awaiting_approval'].some((s) => isTerminal(s as never))).toBe(
      false,
    );
  });

  it('shortens ids', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
  });
});

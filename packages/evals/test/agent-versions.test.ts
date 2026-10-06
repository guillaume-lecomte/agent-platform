import { describe, expect, it } from 'vitest';
import { applyPromote, applyRollback, deployedStack, VersionError } from '../src/index.js';

const initial = {
  active: 'v1',
  history: [
    { action: 'initial' as const, version: 'v1', previous: null, at: '2026-01-01T00:00:00.000Z' },
  ],
};
const at = new Date('2026-02-01T00:00:00.000Z');

describe('promote / rollback', () => {
  it('promotes, records history, and refuses a no-op', () => {
    const next = applyPromote(initial, 'v2', 'evals passed', at);
    expect(next.active).toBe('v2');
    expect(next.history.at(-1)).toEqual({
      action: 'promote',
      version: 'v2',
      previous: 'v1',
      at: at.toISOString(),
      note: 'evals passed',
    });
    expect(() => applyPromote(next, 'v2')).toThrow(VersionError);
  });

  it('rolls back to the previously deployed version and keeps the history', () => {
    const v2 = applyPromote(initial, 'v2', undefined, at);
    const back = applyRollback(v2, 'bad release', at);
    expect(back.active).toBe('v1');
    expect(back.history.map((h) => h.action)).toEqual(['initial', 'promote', 'rollback']);
  });

  it('walks back one deployment at a time (v1 > v2 > v3, rollback twice)', () => {
    let f = applyPromote(initial, 'v2', undefined, at);
    f = applyPromote(f, 'v3', undefined, at);
    expect(deployedStack(f.history)).toEqual(['v1', 'v2', 'v3']);
    f = applyRollback(f, undefined, at);
    expect(f.active).toBe('v2');
    f = applyRollback(f, undefined, at);
    expect(f.active).toBe('v1');
    expect(() => applyRollback(f)).toThrow(/nothing to roll back/);
  });

  it('can promote again after a rollback', () => {
    let f = applyPromote(initial, 'v2', undefined, at);
    f = applyRollback(f, undefined, at);
    f = applyPromote(f, 'v2', undefined, at);
    expect(deployedStack(f.history)).toEqual(['v1', 'v2']);
    expect(f.active).toBe('v2');
  });
});

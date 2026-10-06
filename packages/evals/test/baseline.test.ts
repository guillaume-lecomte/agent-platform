import { describe, expect, it } from 'vitest';
import {
  baselineFromReport,
  compareToBaseline,
  renderMarkdown,
  type Baseline,
  type EvalReport,
} from '../src/index.js';

const report = (
  overall: number,
  categories: Record<string, number>,
  over: Partial<EvalReport> = {},
): EvalReport => ({
  agent: 'a',
  version: 'v2',
  suite: { name: 's', version: 1, cases: 2 },
  mode: 'mock',
  provider: 'mock',
  simulated: true,
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1,
  scores: { overall, categories },
  passedCases: 1,
  skippedGraders: 0,
  usage: { inputTokens: 1, outputTokens: 1, llmCalls: 1, latencyMs: 1 },
  cases: [
    {
      id: 'c1',
      category: 'bug',
      weight: 1,
      score: overall,
      passed: false,
      graders: [],
      run: {
        state: 'completed',
        inputTokens: 1,
        outputTokens: 1,
        llmCalls: 1,
        latencyMs: 1,
        models: [],
        toolCalls: [],
      },
    },
  ],
  ...over,
});

const baseline: Baseline = {
  agent: 'a',
  version: 'v1',
  suite: 's',
  suite_version: 1,
  mode: 'mock',
  createdAt: '2026-01-01T00:00:00.000Z',
  scores: { overall: 0.9, categories: { bug: 0.9, question: 0.9 } },
  cases: { c1: 0.9 },
};
const gate = { max_overall_drop: 0.03, max_category_drop: 0.08 };

describe('compareToBaseline', () => {
  it('passes when scores are equal or better', () => {
    expect(
      compareToBaseline(report(0.95, { bug: 0.95, question: 0.9 }), baseline, gate).passed,
    ).toBe(true);
  });

  it('tolerates a drop up to the threshold, including exactly at it', () => {
    expect(
      compareToBaseline(report(0.87, { bug: 0.9, question: 0.9 }), baseline, gate).passed,
    ).toBe(true);
  });

  it('fails when the overall score drops beyond the threshold', () => {
    const res = compareToBaseline(report(0.86, { bug: 0.9, question: 0.9 }), baseline, gate);
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.name === 'overall')).toMatchObject({ ok: false, delta: -0.04 });
  });

  it('fails when one category drops even if the overall score holds', () => {
    const res = compareToBaseline(report(0.9, { bug: 1, question: 0.8 }), baseline, gate);
    expect(res.passed).toBe(false);
    expect(res.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['category:question']);
  });

  it('fails when a category present in the baseline disappears', () => {
    const res = compareToBaseline(report(0.9, { bug: 0.9 }), baseline, gate);
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.name === 'category:question')).toMatchObject({
      current: undefined,
      ok: false,
    });
  });

  it('honours custom thresholds', () => {
    const lax = { max_overall_drop: 0.2, max_category_drop: 0.2 };
    expect(
      compareToBaseline(report(0.75, { bug: 0.75, question: 0.75 }), baseline, lax).passed,
    ).toBe(true);
  });

  it('names regressed cases and warns when conditions differ', () => {
    const res = compareToBaseline(
      report(0.5, { bug: 0.5, question: 0.5 }, { mode: 'real' }),
      baseline,
      gate,
    );
    expect(res.regressedCases).toEqual([{ id: 'c1', baseline: 0.9, current: 0.5 }]);
    expect(res.warnings[0]).toContain('not comparable');
  });
});

describe('baseline and markdown', () => {
  it('round-trips a report into a baseline', () => {
    const b = baselineFromReport(report(0.9, { bug: 0.9 }));
    expect(b).toMatchObject({ version: 'v2', scores: { overall: 0.9 }, cases: { c1: 0.9 } });
  });

  it('renders the verdict and flags simulated measurements', () => {
    const r = report(0.5, { bug: 0.5, question: 0.5 });
    const md = renderMarkdown(r, compareToBaseline(r, baseline, gate));
    expect(md).toContain('BLOCKED');
    expect(md).toContain('category:question');
    expect(md).toContain('test double');
  });
});

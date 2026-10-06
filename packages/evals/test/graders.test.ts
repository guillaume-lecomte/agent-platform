import { describe, expect, it } from 'vitest';
import {
  computeScores,
  gradeCase,
  getPath,
  parseSuite,
  type AgentRun,
  type EvalCase,
  type EvalSuite,
} from '../src/index.js';

const suite = parseSuite(`
name: s
suite_version: 1
agent: a
output_schema: { type: object, required: [category], properties: { category: { enum: [bug, feature] } } }
cases:
  - { id: c1, category: x, input: {}, graders: [{ type: exact, path: category, expected: bug }] }
`);

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  finalText: '{}',
  output: {
    category: 'bug',
    priority: 'P1',
    labels: ['bug', 'area:ui'],
    comment: 'Please share steps to reproduce.',
    n: { x: 1 },
  },
  toolCalls: [
    { name: 'search', arguments: {} },
    { name: 'post', arguments: {} },
  ],
  state: 'completed',
  usage: { inputTokens: 10, outputTokens: 5, llmCalls: 2 },
  latencyMs: 100,
  models: ['m'],
  simulated: true,
  ...over,
});

const grade = (graders: unknown[], r: AgentRun = run(), s: EvalSuite = suite) =>
  gradeCase({ id: 'c', category: 'x', weight: 1, input: {}, graders } as EvalCase, r, { suite: s });

describe('graders', () => {
  it('exact: passes on equal values (deep) and fails otherwise, with a readable detail', async () => {
    const res = await grade([
      { type: 'exact', path: 'category', expected: 'bug', weight: 1 },
      { type: 'exact', path: 'priority', expected: 'P0', weight: 1 },
      { type: 'exact', path: 'n', expected: { x: 1 }, weight: 1 },
    ]);
    expect(res.graders.map((g) => g.passed)).toEqual([true, false, true]);
    expect(res.graders[1]?.detail).toContain('"P1"');
    expect(res.score).toBeCloseTo(2 / 3);
    expect(res.passed).toBe(false);
  });

  it('one_of, array_includes, regex (with negate), json_schema', async () => {
    const res = await grade([
      { type: 'one_of', path: 'priority', expected: ['P0', 'P1'], weight: 1 },
      { type: 'array_includes', path: 'labels', value: 'area:ui', weight: 1 },
      { type: 'array_includes', path: 'labels', value: 'security', weight: 1 },
      { type: 'regex', path: 'comment', pattern: 'reproduc', flags: 'i', weight: 1, negate: false },
      { type: 'regex', path: 'comment', pattern: 'refund', weight: 1, negate: true },
      { type: 'json_schema', weight: 1 },
    ]);
    expect(res.graders.map((g) => g.passed)).toEqual([true, true, false, true, true, true]);
  });

  it('json_schema fails on a non-conforming or missing answer', async () => {
    expect(
      (await grade([{ type: 'json_schema', weight: 1 }], run({ output: { category: 'nope' } })))
        .passed,
    ).toBe(false);
    const missing = await grade([{ type: 'json_schema', weight: 1 }], run({ output: null }));
    expect(missing.graders[0]?.detail).toContain('not valid JSON');
  });

  it('tool_called honours min/max, tool_not_called checks absence', async () => {
    const res = await grade([
      { type: 'tool_called', tool: 'search', min: 1, weight: 1 },
      { type: 'tool_called', tool: 'search', min: 2, weight: 1 },
      { type: 'tool_called', tool: 'post', min: 1, max: 1, weight: 1 },
      { type: 'tool_not_called', tool: 'delete', weight: 1 },
      { type: 'tool_not_called', tool: 'post', weight: 1 },
    ]);
    expect(res.graders.map((g) => g.passed)).toEqual([true, false, true, true, false]);
  });

  it('weights graders in the case score', async () => {
    const res = await grade([
      { type: 'exact', path: 'category', expected: 'bug', weight: 3 },
      { type: 'exact', path: 'priority', expected: 'P0', weight: 1 },
    ]);
    expect(res.score).toBeCloseTo(0.75);
  });

  it('skips the LLM judge without a judge model, and excludes it from the score', async () => {
    const res = await grade([
      { type: 'exact', path: 'category', expected: 'bug', weight: 1 },
      { type: 'llm_judge', rubric: 'Is it polite?', weight: 5 },
    ]);
    expect(res.graders[1]).toMatchObject({ skipped: true, passed: false });
    expect(res.score).toBe(1);
    expect(res.passed).toBe(true);
  });

  it('uses the judge model when given one', async () => {
    const judge = {
      name: 'judge',
      complete: async () => ({
        content: '{"pass": true, "reason": "polite"}',
        toolCalls: [],
        model: 'j',
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end' as const,
        latencyMs: 1,
        simulated: false,
      }),
    };
    const res = await gradeCase(
      {
        id: 'c',
        category: 'x',
        weight: 1,
        input: {},
        graders: [{ type: 'llm_judge', rubric: 'polite?', weight: 1 }],
      },
      run(),
      { suite, judge },
    );
    expect(res.graders[0]).toMatchObject({ passed: true, detail: 'polite' });
  });

  it('fails every answer-based grader when the task did not complete, but still counts tool calls', async () => {
    const res = await grade(
      [
        { type: 'exact', path: 'category', expected: 'bug', weight: 1 },
        { type: 'tool_called', tool: 'search', min: 1, weight: 1 },
      ],
      run({ state: 'budget_exceeded', error: 'out of tokens', output: null }),
    );
    expect(res.graders[0]?.detail).toContain('budget_exceeded');
    expect(res.graders[1]?.passed).toBe(true);
  });
});

describe('getPath / computeScores / suite parsing', () => {
  it('resolves dotted paths', () => {
    expect(getPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(getPath({ a: 1 }, '$')).toEqual({ a: 1 });
  });

  it('computes weighted overall and per-category scores', () => {
    const mk = (id: string, category: string, score: number, weight = 1) =>
      ({ id, category, score, weight, passed: score === 1, graders: [], run: {} }) as never;
    const s = computeScores([mk('a', 'bug', 1), mk('b', 'bug', 0.5), mk('c', 'q', 0, 2)]);
    expect(s.categories).toEqual({ bug: 0.75, q: 0 });
    expect(s.overall).toBeCloseTo(1.5 / 4, 4);
  });

  it('rejects duplicate case ids and unknown grader types', () => {
    expect(() =>
      parseSuite(`
name: s
suite_version: 1
agent: a
cases:
  - { id: x, category: c, input: {}, graders: [{ type: exact, expected: 1 }] }
  - { id: x, category: c, input: {}, graders: [{ type: exact, expected: 1 }] }
`),
    ).toThrow(/duplicate case id x/);
    expect(() =>
      parseSuite(`
name: s
suite_version: 1
agent: a
cases:
  - { id: x, category: c, input: {}, graders: [{ type: vibes }] }
`),
    ).toThrow();
  });
});

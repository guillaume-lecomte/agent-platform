import { validateJsonSchema, type LLMProvider } from '@agent-platform/core';
import type { EvalCase, EvalSuite, Grader } from './suite.js';
import type { AgentRun, CaseResult, GraderResult } from './types.js';

/** Resolves a dotted path ("labels", "a.b") in a JSON value. No path means the root. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path || path === '$') return value;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

export interface GradeContext {
  suite: EvalSuite;
  /** Absent in mock mode: LLM-judge graders are then skipped. */
  judge?: LLMProvider;
}

type Outcome = { passed: boolean; detail: string; skipped?: boolean };

async function runGrader(grader: Grader, run: AgentRun, ctx: GradeContext): Promise<Outcome> {
  switch (grader.type) {
    case 'exact': {
      const actual = getPath(run.output, grader.path);
      return {
        passed: deepEqual(actual, grader.expected),
        detail: `${grader.path ?? '$'} = ${show(actual)}, expected ${show(grader.expected)}`,
      };
    }
    case 'one_of': {
      const actual = getPath(run.output, grader.path);
      return {
        passed: grader.expected.some((e) => deepEqual(actual, e)),
        detail: `${grader.path ?? '$'} = ${show(actual)}, expected one of ${show(grader.expected)}`,
      };
    }
    case 'array_includes': {
      const actual = getPath(run.output, grader.path);
      const ok = Array.isArray(actual) && actual.some((e) => deepEqual(e, grader.value));
      return {
        passed: ok,
        detail: `${grader.path} = ${show(actual)}, expected to include ${show(grader.value)}`,
      };
    }
    case 'regex': {
      const actual = getPath(run.output, grader.path);
      const text = typeof actual === 'string' ? actual : (run.finalText ?? '');
      const matched = new RegExp(grader.pattern, grader.flags).test(text);
      return {
        passed: matched !== grader.negate,
        detail: `/${grader.pattern}/${grader.flags ?? ''} ${matched ? 'matches' : 'does not match'} ${show(text)}`,
      };
    }
    case 'json_schema': {
      const schema = grader.schema ?? ctx.suite.output_schema;
      if (!schema)
        return { passed: false, detail: 'no schema given and the suite has no output_schema' };
      if (run.output === null || run.output === undefined) {
        return { passed: false, detail: 'the answer is not valid JSON' };
      }
      const v = validateJsonSchema(schema, run.output);
      return { passed: v.valid, detail: v.valid ? 'valid' : v.errors.join('; ') };
    }
    case 'tool_called': {
      const n = run.toolCalls.filter((c) => c.name === grader.tool).length;
      const ok = n >= grader.min && (grader.max === undefined || n <= grader.max);
      return {
        passed: ok,
        detail: `${grader.tool} called ${n} time(s), expected ${grader.min}..${grader.max ?? '∞'}`,
      };
    }
    case 'tool_not_called': {
      const n = run.toolCalls.filter((c) => c.name === grader.tool).length;
      return { passed: n === 0, detail: `${grader.tool} called ${n} time(s), expected none` };
    }
    case 'llm_judge': {
      if (!ctx.judge)
        return { passed: false, skipped: true, detail: 'skipped: no judge model (mock mode)' };
      const answer = getPath(run.output, grader.path) ?? run.finalText;
      const res = await ctx.judge.complete({
        messages: [
          {
            role: 'system',
            content:
              'You are a strict grader. Decide whether the answer satisfies the rubric. Reply with only JSON: {"pass": boolean, "reason": string}.',
          },
          { role: 'user', content: `Rubric: ${grader.rubric}\n\nAnswer:\n${show(answer)}` },
        ],
        temperature: 0,
      });
      try {
        const verdict = JSON.parse(res.content.trim()) as { pass?: boolean; reason?: string };
        return { passed: verdict.pass === true, detail: verdict.reason ?? '' };
      } catch {
        return { passed: false, detail: `judge returned non-JSON: ${show(res.content)}` };
      }
    }
  }
}

/** Grades one case. A run that did not complete fails every grader, with the reason. */
export async function gradeCase(
  testCase: EvalCase,
  run: AgentRun,
  ctx: GradeContext,
): Promise<CaseResult> {
  const results: GraderResult[] = [];
  for (const grader of testCase.graders) {
    let outcome: Outcome;
    if (
      run.state !== 'completed' &&
      grader.type !== 'tool_called' &&
      grader.type !== 'tool_not_called'
    ) {
      outcome = { passed: false, detail: `task ${run.state}${run.error ? `: ${run.error}` : ''}` };
    } else {
      outcome = await runGrader(grader, run, ctx);
    }
    results.push({
      type: grader.type,
      passed: outcome.passed,
      score: outcome.passed ? 1 : 0,
      weight: grader.weight,
      detail: outcome.detail,
      ...(outcome.skipped ? { skipped: true } : {}),
    });
  }
  const counted = results.filter((r) => !r.skipped);
  const totalWeight = counted.reduce((s, r) => s + r.weight, 0);
  const score =
    totalWeight === 0 ? 0 : counted.reduce((s, r) => s + r.score * r.weight, 0) / totalWeight;
  return {
    id: testCase.id,
    category: testCase.category,
    weight: testCase.weight,
    score,
    passed: counted.every((r) => r.passed),
    graders: results,
    run: {
      state: run.state,
      ...(run.error ? { error: run.error } : {}),
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      llmCalls: run.usage.llmCalls,
      latencyMs: run.latencyMs,
      models: run.models,
      toolCalls: run.toolCalls.map((c) => c.name),
    },
  };
}

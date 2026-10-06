import type { LLMProvider } from '@agent-platform/core';
import { gradeCase } from './graders.js';
import type { EvalSuite } from './suite.js';
import type { AgentExecutor, CaseResult, EvalReport, EvalScores } from './types.js';

export function computeScores(cases: CaseResult[]): EvalScores {
  const weighted = (list: CaseResult[]): number => {
    const w = list.reduce((s, c) => s + c.weight, 0);
    return w === 0 ? 0 : list.reduce((s, c) => s + c.score * c.weight, 0) / w;
  };
  const byCategory = new Map<string, CaseResult[]>();
  for (const c of cases) byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  const categories: Record<string, number> = {};
  for (const [name, list] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    categories[name] = round(weighted(list));
  }
  return { overall: round(weighted(cases)), categories };
}

export const round = (n: number): number => Math.round(n * 10_000) / 10_000;

export interface RunSuiteOptions {
  suite: EvalSuite;
  version: string;
  executor: AgentExecutor;
  mode: 'mock' | 'real';
  provider: string;
  judge?: LLMProvider;
  concurrency?: number;
}

/** Runs every case of a suite against an agent and grades the results. */
export async function runSuite(options: RunSuiteOptions): Promise<EvalReport> {
  const { suite, executor } = options;
  const startedAt = new Date();
  const results: CaseResult[] = new Array<CaseResult>(suite.cases.length);
  let simulated = false;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const testCase = suite.cases[i];
      if (!testCase) return;
      const run = await executor(testCase.input);
      simulated ||= run.simulated;
      results[i] = await gradeCase(testCase, run, {
        suite,
        ...(options.judge ? { judge: options.judge } : {}),
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 4, suite.cases.length) }, worker),
  );

  const usage = results.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.run.inputTokens,
      outputTokens: acc.outputTokens + r.run.outputTokens,
      llmCalls: acc.llmCalls + r.run.llmCalls,
      latencyMs: acc.latencyMs + r.run.latencyMs,
    }),
    { inputTokens: 0, outputTokens: 0, llmCalls: 0, latencyMs: 0 },
  );
  return {
    agent: suite.agent,
    version: options.version,
    suite: { name: suite.name, version: suite.suite_version, cases: suite.cases.length },
    mode: options.mode,
    provider: options.provider,
    simulated,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    scores: computeScores(results),
    passedCases: results.filter((r) => r.passed).length,
    skippedGraders: results.reduce((s, r) => s + r.graders.filter((g) => g.skipped).length, 0),
    usage,
    cases: results,
  };
}

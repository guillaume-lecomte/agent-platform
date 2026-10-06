import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { round } from './run-suite.js';
import type { GateConfig } from './suite.js';
import type { EvalReport } from './types.js';

export const baselineSchema = z.object({
  agent: z.string(),
  /** Agent version the baseline was recorded from. */
  version: z.string(),
  suite: z.string(),
  suite_version: z.number(),
  mode: z.enum(['mock', 'real']),
  createdAt: z.string(),
  scores: z.object({ overall: z.number(), categories: z.record(z.string(), z.number()) }),
  /** Per-case scores, to name the cases that regressed. */
  cases: z.record(z.string(), z.number()),
});

export type Baseline = z.infer<typeof baselineSchema>;

export function baselineFromReport(report: EvalReport): Baseline {
  return {
    agent: report.agent,
    version: report.version,
    suite: report.suite.name,
    suite_version: report.suite.version,
    mode: report.mode,
    createdAt: report.startedAt,
    scores: report.scores,
    cases: Object.fromEntries(report.cases.map((c) => [c.id, round(c.score)])),
  };
}

export async function readBaseline(path: string): Promise<Baseline | undefined> {
  try {
    return baselineSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  await writeFile(path, JSON.stringify(baseline, null, 2) + '\n');
}

export interface GateCheck {
  name: string;
  baseline: number | undefined;
  current: number | undefined;
  /** current - baseline. Negative is a drop. */
  delta: number | undefined;
  allowedDrop: number;
  ok: boolean;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
  /** Cases whose score dropped versus the baseline, worst first. */
  regressedCases: Array<{ id: string; baseline: number; current: number }>;
  /** Present when the baseline was recorded with different conditions. */
  warnings: string[];
}

// Absorbs float noise so that an exact tie is never reported as a drop.
const EPSILON = 1e-9;

/**
 * Compares a report with the baseline. The gate fails if the overall score, or any
 * category score recorded in the baseline, dropped by more than the configured threshold.
 */
export function compareToBaseline(
  report: EvalReport,
  baseline: Baseline,
  gate: GateConfig,
): GateResult {
  const checks: GateCheck[] = [];
  const check = (
    name: string,
    base: number,
    cur: number | undefined,
    allowedDrop: number,
  ): void => {
    const delta = cur === undefined ? undefined : round(cur - base);
    checks.push({
      name,
      baseline: base,
      current: cur,
      delta,
      allowedDrop,
      ok: delta !== undefined && delta >= -allowedDrop - EPSILON,
    });
  };
  check('overall', baseline.scores.overall, report.scores.overall, gate.max_overall_drop);
  for (const [category, base] of Object.entries(baseline.scores.categories)) {
    check(`category:${category}`, base, report.scores.categories[category], gate.max_category_drop);
  }

  const regressedCases = report.cases
    .flatMap((c) => {
      const base = baseline.cases[c.id];
      return base !== undefined && c.score < base - EPSILON
        ? [{ id: c.id, baseline: base, current: round(c.score) }]
        : [];
    })
    .sort((a, b) => a.current - a.baseline - (b.current - b.baseline));

  const warnings: string[] = [];
  if (baseline.mode !== report.mode) {
    warnings.push(
      `baseline was recorded in ${baseline.mode} mode, this run is ${report.mode}: scores are not comparable`,
    );
  }
  if (baseline.suite_version !== report.suite.version) {
    warnings.push(
      `baseline is for suite version ${baseline.suite_version}, this run uses ${report.suite.version}`,
    );
  }
  return { passed: checks.every((c) => c.ok), checks, regressedCases, warnings };
}

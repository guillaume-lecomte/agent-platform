import type { ActiveFile } from '@agent-platform/core';
import { readActiveFile } from '@agent-platform/core';
import { applyPromote, applyRollback, VersionError, writeActiveFile } from './agent-versions.js';
import type { GateResult } from './baseline.js';
import type { EvalReport } from './types.js';

export interface PromoteOptions {
  agentDir: string;
  version: string;
  /** Runs the evals for `version` (injected so the policy is testable without a model). */
  evaluate: () => Promise<{ report: EvalReport; gate?: GateResult }>;
}

export type PromoteOutcome =
  | { promoted: true; file: ActiveFile; report: EvalReport }
  | {
      promoted: false;
      reason: 'no_baseline' | 'gate_failed';
      file: ActiveFile;
      report: EvalReport;
    };

/**
 * Makes `version` the active one only if its evals pass the baseline gate.
 * `active.json` is not touched otherwise.
 */
export async function promoteVersion(options: PromoteOptions): Promise<PromoteOutcome> {
  const file = await readActiveFile(options.agentDir);
  if (file.active === options.version) {
    throw new VersionError(`${options.version} is already the active version`);
  }
  const { report, gate } = await options.evaluate();
  if (!gate) return { promoted: false, reason: 'no_baseline', file, report };
  if (!gate.passed) return { promoted: false, reason: 'gate_failed', file, report };
  const updated = applyPromote(
    file,
    options.version,
    `evals passed, overall ${report.scores.overall}`,
  );
  await writeActiveFile(options.agentDir, updated);
  return { promoted: true, file: updated, report };
}

/** Goes back to the previously deployed version and records it in the history. */
export async function rollbackVersion(
  agentDir: string,
  note = 'manual rollback',
): Promise<ActiveFile> {
  const updated = applyRollback(await readActiveFile(agentDir), note);
  await writeActiveFile(agentDir, updated);
  return updated;
}

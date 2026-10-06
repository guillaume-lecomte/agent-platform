import {
  createProvider,
  loadConfig,
  MockProvider,
  readActiveFile,
  type LLMProvider,
} from '@agent-platform/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getAgent } from './agents.js';
import { compareToBaseline, readBaseline, type GateResult } from './baseline.js';
import { createInProcessExecutor } from './in-process.js';
import { renderMarkdown } from './markdown.js';
import { runSuite } from './run-suite.js';
import { loadSuite, type GateConfig } from './suite.js';
import type { EvalReport } from './types.js';

/** Walks up from `start` to the folder containing `pnpm-workspace.yaml`. */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not find the repository root (pnpm-workspace.yaml)');
    dir = parent;
  }
}

export function evalsDir(agentId: string, root = findRepoRoot()): string {
  return join(root, 'evals', agentId);
}

export interface EvaluateOptions {
  agentId: string;
  /** A version like `v2`, or `active` for the one named in active.json. */
  version: string;
  /** `none` skips the comparison. Defaults to `<evals dir>/baseline.json`. */
  baselinePath?: string;
  gateOverrides?: Partial<GateConfig>;
  /** Directory for report.json / report.md. Defaults to `<evals dir>/reports`. */
  outDir?: string;
  env?: Record<string, string | undefined>;
}

export interface EvaluateResult {
  report: EvalReport;
  gate?: GateResult;
  markdown: string;
  reportPaths: { json: string; markdown: string };
}

export async function evaluateVersion(options: EvaluateOptions): Promise<EvaluateResult> {
  const agent = getAgent(options.agentId);
  const version =
    options.version === 'active' ? (await readActiveFile(agent.dir)).active : options.version;
  const dir = evalsDir(options.agentId);
  const suite = await loadSuite(join(dir, 'suite.yaml'));
  const config = loadConfig(options.env ?? process.env);

  const mode = config.LLM_PROVIDER === 'mock' ? 'mock' : 'real';
  const provider: LLMProvider =
    mode === 'mock' ? new MockProvider({ responder: agent.mockResponder }) : createProvider(config);

  const report = await runSuite({
    suite,
    version,
    executor: createInProcessExecutor({ agent, version, provider }),
    mode,
    provider: provider.name,
    ...(mode === 'real' ? { judge: provider } : {}),
  });

  let gate: GateResult | undefined;
  if (options.baselinePath !== 'none') {
    const baseline = await readBaseline(options.baselinePath ?? join(dir, 'baseline.json'));
    if (baseline) {
      gate = compareToBaseline(report, baseline, { ...suite.gate, ...options.gateOverrides });
    }
  }

  const markdown = renderMarkdown(report, gate);
  const outDir = options.outDir ?? join(dir, 'reports');
  await mkdir(outDir, { recursive: true });
  const reportPaths = {
    json: join(outDir, `${version}.json`),
    markdown: join(outDir, `${version}.md`),
  };
  await writeFile(
    reportPaths.json,
    JSON.stringify({ ...report, ...(gate ? { gate } : {}) }, null, 2) + '\n',
  );
  await writeFile(reportPaths.markdown, markdown + '\n');
  return { report, ...(gate ? { gate } : {}), markdown, reportPaths };
}

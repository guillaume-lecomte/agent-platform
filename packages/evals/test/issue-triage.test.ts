import { readActiveFile } from '@agent-platform/core';
import { agentDir } from '@agent-platform/agent-issue-triage';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateVersion } from '../src/index.js';

/** The real agent, real suite, real committed baseline: this is what CI runs. */
describe('issue-triage evals (mock mode)', () => {
  const run = async (version: string) =>
    evaluateVersion({
      agentId: 'issue-triage',
      version,
      outDir: await mkdtemp(join(tmpdir(), 'evals-')),
      env: {},
    });

  it('v1 (the active version) passes the gate against the committed baseline', async () => {
    const { gate, report } = await run('v1');
    expect(gate?.passed).toBe(true);
    expect(report.mode).toBe('mock');
    expect(report.simulated).toBe(true);
    expect(report.scores.overall).toBeGreaterThan(0.9);
  }, 60_000);

  it('v2 (deliberately degraded) is blocked by the gate on the overall score and on categories', async () => {
    const { gate, report } = await run('v2');
    expect(gate?.passed).toBe(false);
    expect(gate?.checks.find((c) => c.name === 'overall')?.ok).toBe(false);
    expect(
      gate?.checks.filter((c) => c.name.startsWith('category:') && !c.ok).length,
    ).toBeGreaterThan(1);
    expect(report.scores.overall).toBeLessThan(0.7);
  }, 60_000);

  it('active.json names a version that exists and passes the gate (what CI deploys)', async () => {
    const { active } = await readActiveFile(agentDir);
    const { gate } = await run(active);
    expect(gate?.passed).toBe(true);
  }, 60_000);
});

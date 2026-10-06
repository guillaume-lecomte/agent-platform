import { readActiveFile } from '@agent-platform/core';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDir } from '@agent-platform/agent-issue-triage';
import { describe, expect, it } from 'vitest';
import {
  VersionError,
  promoteVersion,
  rollbackVersion,
  type EvalReport,
  type GateResult,
} from '../src/index.js';

const report = { scores: { overall: 0.95, categories: {} } } as EvalReport;
const passing: GateResult = { passed: true, checks: [], regressedCases: [], warnings: [] };
const failing: GateResult = { ...passing, passed: false };

async function copyAgent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-'));
  await cp(agentDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  // Start from a clean history, whatever state the real active.json is in.
  await writeFile(
    join(dir, 'active.json'),
    JSON.stringify({
      active: 'v1',
      history: [
        { action: 'initial', version: 'v1', previous: null, at: '2026-01-01T00:00:00.000Z' },
      ],
    }),
  );
  return dir;
}

describe('promoteVersion', () => {
  it('updates active.json only when the gate passes', async () => {
    const dir = await copyAgent();
    const outcome = await promoteVersion({
      agentDir: dir,
      version: 'v3',
      evaluate: async () => ({ report, gate: passing }),
    });
    expect(outcome.promoted).toBe(true);
    const file = await readActiveFile(dir);
    expect(file.active).toBe('v3');
    expect(file.history.at(-1)).toMatchObject({ action: 'promote', version: 'v3', previous: 'v1' });
  });

  it('leaves active.json byte-for-byte unchanged when the gate fails', async () => {
    const dir = await copyAgent();
    const before = await readFile(join(dir, 'active.json'), 'utf8');
    const outcome = await promoteVersion({
      agentDir: dir,
      version: 'v2',
      evaluate: async () => ({ report, gate: failing }),
    });
    expect(outcome).toMatchObject({ promoted: false, reason: 'gate_failed' });
    expect(await readFile(join(dir, 'active.json'), 'utf8')).toBe(before);
  });

  it('refuses to promote without a baseline to compare against', async () => {
    const dir = await copyAgent();
    const outcome = await promoteVersion({
      agentDir: dir,
      version: 'v3',
      evaluate: async () => ({ report }),
    });
    expect(outcome).toMatchObject({ promoted: false, reason: 'no_baseline' });
    expect((await readActiveFile(dir)).active).toBe('v1');
  });

  it('does not even run the evals when the version is already active', async () => {
    const dir = await copyAgent();
    let ran = false;
    await expect(
      promoteVersion({
        agentDir: dir,
        version: 'v1',
        evaluate: async () => ((ran = true), { report, gate: passing }),
      }),
    ).rejects.toThrow(VersionError);
    expect(ran).toBe(false);
  });
});

describe('rollbackVersion', () => {
  it('returns to the previous version and keeps the full history', async () => {
    const dir = await copyAgent();
    await promoteVersion({
      agentDir: dir,
      version: 'v3',
      evaluate: async () => ({ report, gate: passing }),
    });
    const file = await rollbackVersion(dir);
    expect(file.active).toBe('v1');
    expect(file.history.map((h) => h.action)).toEqual(['initial', 'promote', 'rollback']);
    await expect(rollbackVersion(dir)).rejects.toThrow(/nothing to roll back/);
  });
});

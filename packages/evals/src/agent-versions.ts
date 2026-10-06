import { activeFileSchema, readActiveFile, type ActiveFile } from '@agent-platform/core';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Entry = ActiveFile['history'][number];

/**
 * The stack of deployed versions, replayed from the history: a promotion pushes, a
 * rollback pops. The top of the stack is the active version.
 */
export function deployedStack(history: Entry[]): string[] {
  const stack: string[] = [];
  for (const e of history) {
    if (e.action === 'rollback') stack.pop();
    else stack.push(e.version);
  }
  return stack;
}

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionError';
  }
}

export function applyPromote(
  file: ActiveFile,
  version: string,
  note?: string,
  now = new Date(),
): ActiveFile {
  if (file.active === version) throw new VersionError(`${version} is already the active version`);
  const entry: Entry = {
    action: 'promote',
    version,
    previous: file.active,
    at: now.toISOString(),
    ...(note ? { note } : {}),
  };
  return { active: version, history: [...file.history, entry] };
}

export function applyRollback(file: ActiveFile, note?: string, now = new Date()): ActiveFile {
  const stack = deployedStack(file.history);
  const current = stack.at(-1);
  const target = stack.at(-2);
  if (current === undefined || target === undefined) {
    throw new VersionError('nothing to roll back to: no earlier version in the history');
  }
  const entry: Entry = {
    action: 'rollback',
    version: target,
    previous: current,
    at: now.toISOString(),
    ...(note ? { note } : {}),
  };
  return { active: target, history: [...file.history, entry] };
}

export async function writeActiveFile(agentDir: string, file: ActiveFile): Promise<void> {
  activeFileSchema.parse(file);
  await writeFile(join(agentDir, 'active.json'), JSON.stringify(file, null, 2) + '\n');
}

export { readActiveFile };

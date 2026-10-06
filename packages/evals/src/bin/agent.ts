#!/usr/bin/env node
import { readActiveFile } from '@agent-platform/core';
import { parseArgs } from 'node:util';
import { getAgent } from '../agents.js';
import { deployedStack, VersionError } from '../agent-versions.js';
import { evaluateVersion } from '../evaluate.js';
import { promoteVersion, rollbackVersion } from '../promote.js';

const USAGE = `Usage:
  agent promote <agent> <version>   Make <version> active, only if its evals pass the gate
  agent rollback <agent>            Go back to the previously deployed version
  agent status <agent>              Show the active version and the history`;

async function main(): Promise<number> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const [command, agentId, version] = positionals;
  if (!command || !agentId) {
    console.error(USAGE);
    return 2;
  }
  const agent = getAgent(agentId);

  if (command === 'status') {
    const file = await readActiveFile(agent.dir);
    console.log(
      `${agentId}: active ${file.active}; deployed stack ${deployedStack(file.history).join(' > ')}`,
    );
    for (const e of file.history) {
      console.log(
        `  ${e.at}  ${e.action.padEnd(8)} ${e.version}${e.previous ? ` (from ${e.previous})` : ''}${e.note ? `  ${e.note}` : ''}`,
      );
    }
    return 0;
  }

  if (command === 'promote') {
    if (!version) {
      console.error(USAGE);
      return 2;
    }
    await agent.createRuntime(version); // fails early on an unknown version
    console.log(`Running evals for ${agentId}@${version} before promoting...\n`);
    const outcome = await promoteVersion({
      agentDir: agent.dir,
      version,
      evaluate: async () => {
        const result = await evaluateVersion({ agentId, version });
        console.log(result.markdown);
        return result;
      },
    });
    if (outcome.promoted) {
      console.log(
        `\nPromoted: ${agentId} is now on ${version} (was ${outcome.file.history.at(-1)?.previous}).`,
      );
      return 0;
    }
    if (outcome.reason === 'no_baseline') {
      console.error(
        '\nRefusing to promote: no baseline to compare against. Run "evals baseline" first.',
      );
    } else {
      console.error(
        `\nNot promoted: ${agentId}@${version} fails the eval gate. active.json is unchanged (still ${outcome.file.active}).`,
      );
    }
    return 1;
  }

  if (command === 'rollback') {
    const before = await readActiveFile(agent.dir);
    const updated = await rollbackVersion(agent.dir);
    console.log(`Rolled back: ${agentId} is now on ${updated.active} (was ${before.active}).`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof VersionError ? 1 : 2);
  },
);

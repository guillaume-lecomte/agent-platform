import { loadAgentDefinition, readActiveFile, type AnyTool } from '@agent-platform/core';
import { InMemoryEffectLog, type EffectLog } from './effects.js';
import { parseIssueInput, renderIssue } from './input.js';
import { agentDir, createIssueTriageTools } from './tools.js';

export const AGENT_ID = 'issue-triage';

export interface IssueTriageRuntime {
  definition: Awaited<ReturnType<typeof loadAgentDefinition>>;
  tools: AnyTool[];
  validateInput: (input: unknown) => unknown;
  renderInput: (input: unknown) => string;
}

/** Everything the durable runner needs to run one version of this agent. */
export async function resolveIssueTriage(
  version: string,
  effects: EffectLog = new InMemoryEffectLog(),
): Promise<IssueTriageRuntime> {
  return {
    definition: await loadAgentDefinition(agentDir, version),
    tools: createIssueTriageTools(effects),
    validateInput: parseIssueInput,
    renderInput: renderIssue,
  };
}

/** Version currently deployed (`active.json`). */
export async function activeIssueTriageVersion(): Promise<string> {
  return (await readActiveFile(agentDir)).active;
}

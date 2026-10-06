import type { MockResponder } from '@agent-platform/core';
import {
  AGENT_ID as ISSUE_TRIAGE,
  agentDir as issueTriageDir,
  issueTriageResponder,
  resolveIssueTriage,
} from '@agent-platform/agent-issue-triage';
import type { AgentRuntime } from '@agent-platform/durable-runner';

/**
 * Static registry of the agents this repository ships. Adding an agent means adding an
 * entry here; discovery by convention is out of scope for a POC (see ADR 0005).
 */
export interface RegisteredAgent {
  id: string;
  /** Folder holding `v1.yaml`, `v2.yaml`, `active.json`. */
  dir: string;
  createRuntime(version: string): Promise<AgentRuntime>;
  /** Scripted behaviour used by the mock provider. */
  mockResponder: MockResponder;
}

export const agents: Record<string, RegisteredAgent> = {
  [ISSUE_TRIAGE]: {
    id: ISSUE_TRIAGE,
    dir: issueTriageDir,
    createRuntime: (version) => resolveIssueTriage(version),
    mockResponder: issueTriageResponder,
  },
};

export function getAgent(id: string): RegisteredAgent {
  const agent = agents[id];
  if (!agent)
    throw new Error(`unknown agent "${id}". Known agents: ${Object.keys(agents).join(', ')}`);
  return agent;
}

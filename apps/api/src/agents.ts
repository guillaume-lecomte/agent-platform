import {
  AGENT_ID,
  PgEffectLog,
  activeIssueTriageVersion,
  resolveIssueTriage,
} from '@agent-platform/agent-issue-triage';
import { NotFoundError, type AgentResolver } from '@agent-platform/durable-runner';
import type { Pool } from 'pg';

export interface AgentCatalog {
  resolver: AgentResolver;
  activeVersion: (agentId: string) => Promise<string>;
  ids: string[];
  effects: PgEffectLog;
}

/** The agents hosted by this API. Static registry: see docs/decisions/0005. */
export function createAgentCatalog(pool: Pool): AgentCatalog {
  const effects = new PgEffectLog(pool);
  return {
    ids: [AGENT_ID],
    effects,
    resolver: async (agentId, version) => {
      if (agentId !== AGENT_ID) throw new NotFoundError('agent', agentId);
      return resolveIssueTriage(version, effects);
    },
    activeVersion: async (agentId) => {
      if (agentId !== AGENT_ID) throw new NotFoundError('agent', agentId);
      return activeIssueTriageVersion();
    },
  };
}

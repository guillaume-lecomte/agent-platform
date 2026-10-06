/** What an agent did on one case, as seen by the graders. */
export interface AgentRun {
  /** Final assistant message, if the task completed. */
  finalText: string | null;
  /** Final message parsed as JSON, when it is JSON. */
  output: unknown;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Final task state (completed, failed, budget_exceeded...). */
  state: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  /** Sum of the latency of every model call (simulated in mock mode). */
  latencyMs: number;
  models: string[];
  simulated: boolean;
}

export type AgentExecutor = (input: unknown) => Promise<AgentRun>;

export interface GraderResult {
  type: string;
  passed: boolean;
  /** 0 or 1 for deterministic graders. */
  score: number;
  weight: number;
  detail: string;
  /** Not run (e.g. LLM judge in mock mode); excluded from the case score. */
  skipped?: boolean;
}

export interface CaseResult {
  id: string;
  category: string;
  weight: number;
  /** Weighted mean of the graders that ran, 0..1. */
  score: number;
  passed: boolean;
  graders: GraderResult[];
  run: {
    state: string;
    error?: string;
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    latencyMs: number;
    models: string[];
    toolCalls: string[];
  };
}

export interface EvalScores {
  overall: number;
  categories: Record<string, number>;
}

export interface EvalReport {
  agent: string;
  version: string;
  suite: { name: string; version: number; cases: number };
  mode: 'mock' | 'real';
  provider: string;
  /** True when token counts and latencies come from a test double. */
  simulated: boolean;
  startedAt: string;
  durationMs: number;
  scores: EvalScores;
  passedCases: number;
  skippedGraders: number;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number; latencyMs: number };
  cases: CaseResult[];
}

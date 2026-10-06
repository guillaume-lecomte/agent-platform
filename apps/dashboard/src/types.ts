/** Shapes returned by the API. Mirrored here so the dashboard does not bundle server code. */

export type TaskState =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'budget_exceeded'
  | 'cancelled';

export interface AgentTask {
  id: string;
  agentId: string;
  agentVersion: string;
  input: { number?: number; title?: string; body?: string } & Record<string, unknown>;
  state: TaskState;
  tokenBudget: number;
  tokensUsed: number;
  result: { text?: string; json?: Record<string, unknown> | null } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStep {
  taskId: string;
  seq: number;
  kind: 'llm' | 'tool';
  payload: {
    // llm
    content?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    model?: string;
    latencyMs?: number;
    simulated?: boolean;
    cached?: boolean;
    // tool
    name?: string;
    outcome?: string;
    isError?: boolean;
  };
  inputTokens: number;
  outputTokens: number;
}

export interface Approval {
  id: string;
  taskId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  risk: 'read' | 'reversible' | 'destructive';
  status: 'pending' | 'approved' | 'denied';
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface TaskEvent {
  type: string;
  taskId: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface ModelSummary {
  model: string;
  calls: number;
  errors: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
  savedUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  simulated: boolean;
}

export interface CostSummary {
  simulated: boolean;
  totals: {
    calls: number;
    cacheHits: number;
    costUsd: number;
    savedUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
  byModel: ModelSummary[];
  pricing: {
    updated: string;
    currency: string;
    perTokens: number;
    models: Array<{
      model: string;
      provider: string;
      input: number;
      output: number;
      simulated: boolean;
      source: string;
      retrieved: string;
    }>;
  };
}

import type { RiskLevel, ToolCall } from '@agent-platform/core';

export type TaskState =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'budget_exceeded'
  | 'cancelled';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'budget_exceeded',
  'cancelled',
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface AgentTask {
  id: string;
  /** Client-supplied key; creating a task twice with the same key returns the first one. */
  idempotencyKey: string;
  agentId: string;
  /** Pinned at creation, so promoting or rolling back an agent never alters a running task. */
  agentVersion: string;
  input: unknown;
  state: TaskState;
  tokenBudget: number;
  tokensUsed: number;
  result: unknown;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  idempotencyKey: string;
  agentId: string;
  agentVersion: string;
  input: unknown;
  tokenBudget: number;
}

/** One model call, with the assistant turn it produced. */
export interface LlmStepPayload {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  latencyMs: number;
  simulated: boolean;
  cached?: boolean;
}

export type ToolOutcome =
  /** Executed in this run. */
  | 'executed'
  /** Result taken from the registry: a previous run already executed it. */
  | 'replayed'
  /** A human declined the call; the agent is told so. */
  | 'denied'
  /** A previous run may have executed it, then crashed. Not re-run; the agent is told. */
  | 'unknown'
  /** The call was invalid (unknown tool, bad arguments). */
  | 'rejected';

export interface ToolStepPayload {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  content: string;
  isError: boolean;
  outcome: ToolOutcome;
}

export type StepKind = 'llm' | 'tool';

export interface TaskStep<P = LlmStepPayload | ToolStepPayload> {
  taskId: string;
  /** 1-based, gapless, unique per task. The ordering of the conversation. */
  seq: number;
  kind: StepKind;
  payload: P;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface NewStep {
  kind: StepKind;
  payload: LlmStepPayload | ToolStepPayload;
  inputTokens?: number;
  outputTokens?: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Approval {
  id: string;
  taskId: string;
  /** Seq of the LLM step that requested the tool call. */
  stepSeq: number;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  risk: RiskLevel;
  status: ApprovalStatus;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export type NewApproval = Pick<
  Approval,
  'taskId' | 'stepSeq' | 'toolCallId' | 'toolName' | 'arguments' | 'risk'
>;

export interface ToolExecutionKey {
  taskId: string;
  /** Seq of the LLM step that requested the call. */
  stepSeq: number;
  /** Hash of tool name and canonical arguments. */
  argsHash: string;
}

export interface ToolExecution extends ToolExecutionKey {
  toolName: string;
  risk: RiskLevel;
  status: 'started' | 'completed';
  result: string | null;
  isError: boolean;
  startedAt: string;
  completedAt: string | null;
}

export type TaskEventType =
  | 'task.created'
  | 'task.started'
  | 'task.resumed'
  | 'task.step'
  | 'task.retry'
  | 'task.awaiting_approval'
  | 'task.approval_decided'
  | 'task.completed'
  | 'task.failed'
  | 'task.budget_exceeded'
  | 'task.cancelled';

/** Lifecycle event, streamed to the dashboard. */
export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  at: string;
  data?: Record<string, unknown>;
}

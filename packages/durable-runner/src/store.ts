import type {
  AgentTask,
  Approval,
  ApprovalStatus,
  NewApproval,
  NewStep,
  NewTask,
  TaskState,
  TaskStep,
  ToolExecution,
  ToolExecutionKey,
} from './types.js';

export interface TaskPatch {
  result?: unknown;
  error?: string | null;
}

/**
 * Persistence port of the runner. Two implementations: PostgreSQL (production, tested
 * against a real database) and in-memory (unit tests of the loop). Every method that
 * guards a correctness property is atomic.
 */
export interface TaskStore {
  /** Creates a task, or returns the existing one for the same idempotency key. */
  createTask(input: NewTask): Promise<{ task: AgentTask; created: boolean }>;
  getTask(id: string): Promise<AgentTask | undefined>;
  listTasks(options?: { state?: TaskState; limit?: number }): Promise<AgentTask[]>;
  countTasksByState(): Promise<Partial<Record<TaskState, number>>>;

  /**
   * Compare-and-set on the state. Returns the updated task, or undefined if the task
   * was not in one of the `from` states.
   */
  transition(
    id: string,
    from: TaskState[],
    to: TaskState,
    patch?: TaskPatch,
  ): Promise<AgentTask | undefined>;
  /** Flags a running task for cancellation; the runner observes it at its next checkpoint. */
  requestCancel(id: string): Promise<void>;

  /**
   * Appends step number `seq`, and adds its token usage to the task, atomically.
   * Throws StepConflictError if that seq already exists.
   */
  appendStep(taskId: string, seq: number, step: NewStep): Promise<TaskStep>;
  listSteps(taskId: string): Promise<TaskStep[]>;

  /**
   * Tool-call registry. Inserts a `started` record if none exists for the key.
   * `inserted` is true only for the caller that created it.
   */
  beginToolExecution(
    key: ToolExecutionKey,
    meta: Pick<ToolExecution, 'toolName' | 'risk'>,
  ): Promise<{ record: ToolExecution; inserted: boolean }>;
  completeToolExecution(key: ToolExecutionKey, result: string, isError: boolean): Promise<void>;

  /** Idempotent: returns the existing approval for (task, step, tool call) if present. */
  createApproval(input: NewApproval): Promise<Approval>;
  getApproval(id: string): Promise<Approval | undefined>;
  findApproval(taskId: string, stepSeq: number, toolCallId: string): Promise<Approval | undefined>;
  listApprovals(options?: { status?: ApprovalStatus; taskId?: string }): Promise<Approval[]>;
  /** Moves a pending approval to approved/denied. Undefined if it was not pending. */
  decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    reason: string | null,
  ): Promise<Approval | undefined>;
}

import { randomUUID } from 'node:crypto';
import { StepConflictError } from './errors.js';
import type { TaskPatch, TaskStore } from './store.js';
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

const keyOf = (k: ToolExecutionKey): string => `${k.taskId}:${k.stepSeq}:${k.argsHash}`;

/** In-memory TaskStore, used by unit tests and by evals (no database needed). */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly byKey = new Map<string, string>();
  private readonly steps = new Map<string, TaskStep[]>();
  private readonly tools = new Map<string, ToolExecution>();
  private readonly approvals = new Map<string, Approval>();

  createTask(input: NewTask): Promise<{ task: AgentTask; created: boolean }> {
    const existingId = this.byKey.get(input.idempotencyKey);
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existing) return Promise.resolve({ task: { ...existing }, created: false });
    const now = new Date().toISOString();
    const task: AgentTask = {
      id: randomUUID(),
      ...input,
      state: 'pending',
      tokensUsed: 0,
      result: null,
      error: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.byKey.set(task.idempotencyKey, task.id);
    this.steps.set(task.id, []);
    return Promise.resolve({ task: { ...task }, created: true });
  }

  getTask(id: string): Promise<AgentTask | undefined> {
    const t = this.tasks.get(id);
    return Promise.resolve(t ? { ...t } : undefined);
  }

  listTasks(options: { state?: TaskState; limit?: number } = {}): Promise<AgentTask[]> {
    let all = [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.state) all = all.filter((t) => t.state === options.state);
    return Promise.resolve(all.slice(0, options.limit ?? 100).map((t) => ({ ...t })));
  }

  countTasksByState(): Promise<Partial<Record<TaskState, number>>> {
    const counts: Partial<Record<TaskState, number>> = {};
    for (const t of this.tasks.values()) counts[t.state] = (counts[t.state] ?? 0) + 1;
    return Promise.resolve(counts);
  }

  transition(
    id: string,
    from: TaskState[],
    to: TaskState,
    patch: TaskPatch = {},
  ): Promise<AgentTask | undefined> {
    const t = this.tasks.get(id);
    if (!t || !from.includes(t.state)) return Promise.resolve(undefined);
    t.state = to;
    if (patch.result !== undefined) t.result = patch.result;
    if (patch.error !== undefined) t.error = patch.error;
    t.updatedAt = new Date().toISOString();
    return Promise.resolve({ ...t });
  }

  requestCancel(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t) t.cancelRequested = true;
    return Promise.resolve();
  }

  appendStep(taskId: string, seq: number, step: NewStep): Promise<TaskStep> {
    const list = this.steps.get(taskId);
    const task = this.tasks.get(taskId);
    if (!list || !task) return Promise.reject(new Error(`task ${taskId} not found`));
    if (list.some((s) => s.seq === seq)) return Promise.reject(new StepConflictError(taskId, seq));
    const row: TaskStep = {
      taskId,
      seq,
      kind: step.kind,
      payload: step.payload,
      inputTokens: step.inputTokens ?? 0,
      outputTokens: step.outputTokens ?? 0,
      createdAt: new Date().toISOString(),
    };
    list.push(row);
    task.tokensUsed += row.inputTokens + row.outputTokens;
    task.updatedAt = row.createdAt;
    return Promise.resolve(row);
  }

  listSteps(taskId: string): Promise<TaskStep[]> {
    return Promise.resolve([...(this.steps.get(taskId) ?? [])].sort((a, b) => a.seq - b.seq));
  }

  beginToolExecution(
    key: ToolExecutionKey,
    meta: Pick<ToolExecution, 'toolName' | 'risk'>,
  ): Promise<{ record: ToolExecution; inserted: boolean }> {
    const existing = this.tools.get(keyOf(key));
    if (existing) return Promise.resolve({ record: { ...existing }, inserted: false });
    const record: ToolExecution = {
      ...key,
      ...meta,
      status: 'started',
      result: null,
      isError: false,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.tools.set(keyOf(key), record);
    return Promise.resolve({ record: { ...record }, inserted: true });
  }

  completeToolExecution(key: ToolExecutionKey, result: string, isError: boolean): Promise<void> {
    const r = this.tools.get(keyOf(key));
    if (r) {
      r.status = 'completed';
      r.result = result;
      r.isError = isError;
      r.completedAt = new Date().toISOString();
    }
    return Promise.resolve();
  }

  createApproval(input: NewApproval): Promise<Approval> {
    const existing = [...this.approvals.values()].find(
      (a) =>
        a.taskId === input.taskId &&
        a.stepSeq === input.stepSeq &&
        a.toolCallId === input.toolCallId,
    );
    if (existing) return Promise.resolve({ ...existing });
    const approval: Approval = {
      id: randomUUID(),
      ...input,
      status: 'pending',
      reason: null,
      requestedAt: new Date().toISOString(),
      decidedAt: null,
    };
    this.approvals.set(approval.id, approval);
    return Promise.resolve({ ...approval });
  }

  getApproval(id: string): Promise<Approval | undefined> {
    const a = this.approvals.get(id);
    return Promise.resolve(a ? { ...a } : undefined);
  }

  findApproval(taskId: string, stepSeq: number, toolCallId: string): Promise<Approval | undefined> {
    const a = [...this.approvals.values()].find(
      (x) => x.taskId === taskId && x.stepSeq === stepSeq && x.toolCallId === toolCallId,
    );
    return Promise.resolve(a ? { ...a } : undefined);
  }

  listApprovals(options: { status?: ApprovalStatus; taskId?: string } = {}): Promise<Approval[]> {
    return Promise.resolve(
      [...this.approvals.values()]
        .filter((a) => (options.status ? a.status === options.status : true))
        .filter((a) => (options.taskId ? a.taskId === options.taskId : true))
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        .map((a) => ({ ...a })),
    );
  }

  decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    reason: string | null,
  ): Promise<Approval | undefined> {
    const a = this.approvals.get(id);
    if (!a || a.status !== 'pending') return Promise.resolve(undefined);
    a.status = decision;
    a.reason = reason;
    a.decidedAt = new Date().toISOString();
    return Promise.resolve({ ...a });
  }
}

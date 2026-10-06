import type { Database } from '@agent-platform/core';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { StepConflictError } from './errors.js';
import { agentTasks, approvals, taskSteps, toolExecutions } from './schema.js';
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
import type { RiskLevel } from '@agent-platform/core';

const iso = (v: string): string => new Date(v).toISOString();
const isoOrNull = (v: string | null): string | null => (v === null ? null : iso(v));

function toTask(r: typeof agentTasks.$inferSelect): AgentTask {
  return {
    id: r.id,
    idempotencyKey: r.idempotencyKey,
    agentId: r.agentId,
    agentVersion: r.agentVersion,
    input: r.input,
    state: r.state as TaskState,
    tokenBudget: r.tokenBudget,
    tokensUsed: r.tokensUsed,
    result: r.result,
    error: r.error,
    cancelRequested: r.cancelRequested,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function toStep(r: typeof taskSteps.$inferSelect): TaskStep {
  return {
    taskId: r.taskId,
    seq: r.seq,
    kind: r.kind as TaskStep['kind'],
    payload: r.payload as TaskStep['payload'],
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    createdAt: iso(r.createdAt),
  };
}

function toExecution(r: typeof toolExecutions.$inferSelect): ToolExecution {
  return {
    taskId: r.taskId,
    stepSeq: r.stepSeq,
    argsHash: r.argsHash,
    toolName: r.toolName,
    risk: r.risk as RiskLevel,
    status: r.status as ToolExecution['status'],
    result: r.result,
    isError: r.isError,
    startedAt: iso(r.startedAt),
    completedAt: isoOrNull(r.completedAt),
  };
}

function toApproval(r: typeof approvals.$inferSelect): Approval {
  return {
    id: r.id,
    taskId: r.taskId,
    stepSeq: r.stepSeq,
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    arguments: r.arguments as Record<string, unknown>,
    risk: r.risk as RiskLevel,
    status: r.status as ApprovalStatus,
    reason: r.reason,
    requestedAt: iso(r.requestedAt),
    decidedAt: isoOrNull(r.decidedAt),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** PostgreSQL implementation of the TaskStore port. */
export class PgTaskStore implements TaskStore {
  constructor(private readonly db: Database) {}

  async createTask(input: NewTask): Promise<{ task: AgentTask; created: boolean }> {
    const inserted = await this.db
      .insert(agentTasks)
      .values({
        idempotencyKey: input.idempotencyKey,
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        input: input.input,
        tokenBudget: input.tokenBudget,
      })
      .onConflictDoNothing({ target: agentTasks.idempotencyKey })
      .returning();
    if (inserted[0]) return { task: toTask(inserted[0]), created: true };
    const [existing] = await this.db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.idempotencyKey, input.idempotencyKey));
    if (!existing) throw new Error('task vanished after idempotency conflict');
    return { task: toTask(existing), created: false };
  }

  async getTask(id: string): Promise<AgentTask | undefined> {
    const [row] = await this.db.select().from(agentTasks).where(eq(agentTasks.id, id));
    return row ? toTask(row) : undefined;
  }

  async listTasks(options: { state?: TaskState; limit?: number } = {}): Promise<AgentTask[]> {
    const rows = await this.db
      .select()
      .from(agentTasks)
      .where(options.state ? eq(agentTasks.state, options.state) : undefined)
      .orderBy(desc(agentTasks.createdAt))
      .limit(options.limit ?? 100);
    return rows.map(toTask);
  }

  async countTasksByState(): Promise<Partial<Record<TaskState, number>>> {
    const rows = await this.db
      .select({ state: agentTasks.state, n: sql<number>`count(*)::int` })
      .from(agentTasks)
      .groupBy(agentTasks.state);
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  async transition(
    id: string,
    from: TaskState[],
    to: TaskState,
    patch: TaskPatch = {},
  ): Promise<AgentTask | undefined> {
    const [row] = await this.db
      .update(agentTasks)
      .set({
        state: to,
        updatedAt: sql`now()`,
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
      })
      .where(and(eq(agentTasks.id, id), inArray(agentTasks.state, from)))
      .returning();
    return row ? toTask(row) : undefined;
  }

  async requestCancel(id: string): Promise<void> {
    await this.db
      .update(agentTasks)
      .set({ cancelRequested: true, updatedAt: sql`now()` })
      .where(eq(agentTasks.id, id));
  }

  async appendStep(taskId: string, seq: number, step: NewStep): Promise<TaskStep> {
    const inputTokens = step.inputTokens ?? 0;
    const outputTokens = step.outputTokens ?? 0;
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(taskSteps)
          .values({
            taskId,
            seq,
            kind: step.kind,
            payload: step.payload,
            inputTokens,
            outputTokens,
          })
          .returning();
        await tx
          .update(agentTasks)
          .set({
            tokensUsed: sql`${agentTasks.tokensUsed} + ${inputTokens + outputTokens}`,
            updatedAt: sql`now()`,
          })
          .where(eq(agentTasks.id, taskId));
        if (!row) throw new Error('insert returned no row');
        return toStep(row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new StepConflictError(taskId, seq);
      throw err;
    }
  }

  async listSteps(taskId: string): Promise<TaskStep[]> {
    const rows = await this.db
      .select()
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId))
      .orderBy(asc(taskSteps.seq));
    return rows.map(toStep);
  }

  async beginToolExecution(
    key: ToolExecutionKey,
    meta: Pick<ToolExecution, 'toolName' | 'risk'>,
  ): Promise<{ record: ToolExecution; inserted: boolean }> {
    const inserted = await this.db
      .insert(toolExecutions)
      .values({ ...key, toolName: meta.toolName, risk: meta.risk, status: 'started' })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { record: toExecution(inserted[0]), inserted: true };
    const [existing] = await this.db
      .select()
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.taskId, key.taskId),
          eq(toolExecutions.stepSeq, key.stepSeq),
          eq(toolExecutions.argsHash, key.argsHash),
        ),
      );
    if (!existing) throw new Error('tool execution vanished after conflict');
    return { record: toExecution(existing), inserted: false };
  }

  async completeToolExecution(
    key: ToolExecutionKey,
    result: string,
    isError: boolean,
  ): Promise<void> {
    await this.db
      .update(toolExecutions)
      .set({ status: 'completed', result, isError, completedAt: sql`now()` })
      .where(
        and(
          eq(toolExecutions.taskId, key.taskId),
          eq(toolExecutions.stepSeq, key.stepSeq),
          eq(toolExecutions.argsHash, key.argsHash),
        ),
      );
  }

  async createApproval(input: NewApproval): Promise<Approval> {
    const inserted = await this.db
      .insert(approvals)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return toApproval(inserted[0]);
    const existing = await this.findApproval(input.taskId, input.stepSeq, input.toolCallId);
    if (!existing) throw new Error('approval vanished after conflict');
    return existing;
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const [row] = await this.db.select().from(approvals).where(eq(approvals.id, id));
    return row ? toApproval(row) : undefined;
  }

  async findApproval(
    taskId: string,
    stepSeq: number,
    toolCallId: string,
  ): Promise<Approval | undefined> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, taskId),
          eq(approvals.stepSeq, stepSeq),
          eq(approvals.toolCallId, toolCallId),
        ),
      );
    return row ? toApproval(row) : undefined;
  }

  async listApprovals(
    options: { status?: ApprovalStatus; taskId?: string } = {},
  ): Promise<Approval[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(
        and(
          options.status ? eq(approvals.status, options.status) : undefined,
          options.taskId ? eq(approvals.taskId, options.taskId) : undefined,
        ),
      )
      .orderBy(asc(approvals.requestedAt));
    return rows.map(toApproval);
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    reason: string | null,
  ): Promise<Approval | undefined> {
    const [row] = await this.db
      .update(approvals)
      .set({ status: decision, reason, decidedAt: sql`now()` })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .returning();
    return row ? toApproval(row) : undefined;
  }
}

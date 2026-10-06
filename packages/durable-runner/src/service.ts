import type { Logger } from '@agent-platform/core';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from './errors.js';
import type { EventBus } from './events.js';
import type { AgentResolver, AgentRunner } from './runner.js';
import type { TaskScheduler } from './queue.js';
import type { TaskStore } from './store.js';
import {
  isTerminal,
  type AgentTask,
  type Approval,
  type TaskEvent,
  type TaskEventType,
  type TaskStep,
} from './types.js';

export interface CreateTaskInput {
  agentId: string;
  /** Defaults to the agent's active version (`agents/<id>/active.json`). */
  agentVersion?: string;
  input: unknown;
  /** Defaults to a fresh UUID, i.e. no deduplication. */
  idempotencyKey?: string;
  /** Defaults to the budget in the agent definition. */
  tokenBudget?: number;
}

export interface TaskServiceDeps {
  store: TaskStore;
  scheduler: TaskScheduler;
  bus: EventBus;
  resolver: AgentResolver;
  logger: Logger;
  /** Version deployed for an agent (what `agents/<id>/active.json` points at). */
  activeVersion: (agentId: string) => Promise<string>;
  /** Present when the runner lives in this process; lets cancel interrupt a model call. */
  runner?: AgentRunner;
}

/** Use cases behind the REST API: create, approve, deny, cancel, query. */
export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async createTask(input: CreateTaskInput): Promise<{ task: AgentTask; created: boolean }> {
    const { store, scheduler, resolver } = this.deps;
    const version = input.agentVersion ?? (await this.deps.activeVersion(input.agentId));
    const runtime = await resolver(input.agentId, version);
    // Throws on invalid input, before anything is persisted.
    const normalized = runtime.validateInput ? runtime.validateInput(input.input) : input.input;
    const { task, created } = await store.createTask({
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      agentId: input.agentId,
      agentVersion: version,
      input: normalized,
      tokenBudget: input.tokenBudget ?? runtime.definition.tokenBudget,
    });
    if (created) {
      await this.emit('task.created', task.id, { agent: `${task.agentId}@${task.agentVersion}` });
      await scheduler.enqueue(task.id);
    }
    return { task, created };
  }

  async getTask(id: string): Promise<AgentTask> {
    const task = await this.deps.store.getTask(id);
    if (!task) throw new NotFoundError('task', id);
    return task;
  }

  listTasks(options?: { limit?: number }): Promise<AgentTask[]> {
    return this.deps.store.listTasks(options);
  }

  async getSteps(taskId: string): Promise<TaskStep[]> {
    await this.getTask(taskId);
    return this.deps.store.listSteps(taskId);
  }

  listApprovals(options?: { status?: Approval['status']; taskId?: string }): Promise<Approval[]> {
    return this.deps.store.listApprovals(options);
  }

  approve(approvalId: string, reason?: string): Promise<Approval> {
    return this.decide(approvalId, 'approved', reason ?? null);
  }

  /** The agent receives the refusal (and the reason) as the tool result. */
  deny(approvalId: string, reason: string): Promise<Approval> {
    return this.decide(approvalId, 'denied', reason);
  }

  async cancel(taskId: string): Promise<AgentTask> {
    const { store } = this.deps;
    const task = await this.getTask(taskId);
    if (isTerminal(task.state)) throw new ConflictError(`task is already ${task.state}`);
    // Not being executed right now: cancel immediately.
    const direct = await store.transition(taskId, ['pending', 'awaiting_approval'], 'cancelled');
    if (direct) {
      await this.emit('task.cancelled', taskId, { state: 'cancelled' });
      return direct;
    }
    // Running: the runner stops at its next checkpoint.
    await store.requestCancel(taskId);
    this.deps.runner?.abortLocal(taskId);
    return this.getTask(taskId);
  }

  /**
   * Safety net, run at startup: wakes tasks whose wake-up may have been lost
   * (a crash between deciding an approval and scheduling the resume).
   */
  async reconcile(): Promise<number> {
    const { store, scheduler } = this.deps;
    let woken = 0;
    for (const task of await store.listTasks({ state: 'awaiting_approval', limit: 1000 })) {
      const pending = await store.listApprovals({ taskId: task.id, status: 'pending' });
      if (pending.length === 0) {
        if (await store.transition(task.id, ['awaiting_approval'], 'pending')) {
          await scheduler.enqueue(task.id);
          woken++;
        }
      }
    }
    return woken;
  }

  private async decide(
    approvalId: string,
    decision: 'approved' | 'denied',
    reason: string | null,
  ): Promise<Approval> {
    const { store, scheduler } = this.deps;
    const existing = await store.getApproval(approvalId);
    if (!existing) throw new NotFoundError('approval', approvalId);
    const decided = await store.decideApproval(approvalId, decision, reason);
    if (!decided) throw new ConflictError(`approval was already ${existing.status}`);
    await this.emit('task.approval_decided', decided.taskId, {
      approvalId,
      decision,
      tool: decided.toolName,
    });
    const resumed = await store.transition(decided.taskId, ['awaiting_approval'], 'pending');
    if (resumed) await scheduler.enqueue(decided.taskId);
    return decided;
  }

  private async emit(
    type: TaskEventType,
    taskId: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const event: TaskEvent = {
      type,
      taskId,
      at: new Date().toISOString(),
      ...(data ? { data } : {}),
    };
    try {
      await this.deps.bus.publish(event);
    } catch (err) {
      this.deps.logger.warn({ err: String(err), type }, 'failed to publish event');
    }
  }
}

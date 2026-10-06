import {
  LLMError,
  canonicalJson,
  estimateInputTokens,
  sha256,
  validateJsonSchema,
  type AgentDefinition,
  type AnyTool,
  type LLMProvider,
  type LLMRequest,
  type Logger,
  type ToolSpec,
} from '@agent-platform/core';
import { NotFoundError, StepConflictError } from './errors.js';
import type { EventBus } from './events.js';
import { buildMessages, defaultRenderInput, lastLlmStep, pendingToolCalls } from './messages.js';
import { retryTransient, type RetryOptions } from './retry.js';
import type { TaskStore } from './store.js';
import {
  isTerminal,
  type AgentTask,
  type LlmStepPayload,
  type TaskEvent,
  type TaskEventType,
  type TaskState,
  type ToolOutcome,
  type ToolStepPayload,
} from './types.js';

/** What the runner needs to execute one version of one agent. */
export interface AgentRuntime {
  definition: AgentDefinition;
  tools: AnyTool[];
  /** Validates and normalizes the input of a new task; throws to reject it. */
  validateInput?: (input: unknown) => unknown;
  /** Turns the task input into the first user message. */
  renderInput?: (input: unknown) => string;
}

export type AgentResolver = (agentId: string, version: string) => Promise<AgentRuntime>;

/** Optional instrumentation points; the API wires them to Prometheus. */
export interface RunnerHooks {
  onTaskFinished?: (task: AgentTask, state: TaskState) => void;
  onLlmRetry?: (info: { taskId: string; attempt: number; delayMs: number; kind: string }) => void;
  onToolCall?: (info: { taskId: string; tool: string; outcome: ToolOutcome }) => void;
}

export interface RunnerDeps {
  store: TaskStore;
  provider: LLMProvider;
  resolver: AgentResolver;
  bus: EventBus;
  logger: Logger;
  retry?: Partial<RetryOptions>;
  hooks?: RunnerHooks;
}

export interface AdvanceResult {
  state: TaskState;
}

/**
 * Advances an agent task as far as it can go: until it finishes, needs a human
 * approval, or is stopped. It is safe to call again at any time: all progress lives
 * in the store, so a call after a crash continues from the last checkpoint.
 */
export class AgentRunner {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: RunnerDeps) {}

  /** Aborts the in-flight LLM call of a task running in this process, if any. */
  abortLocal(taskId: string): void {
    this.controllers.get(taskId)?.abort();
  }

  async advance(taskId: string): Promise<AdvanceResult> {
    const { store } = this.deps;
    const task = await store.getTask(taskId);
    if (!task) throw new NotFoundError('task', taskId);
    // Terminal tasks are done; awaiting_approval tasks only move through the approval flow.
    if (isTerminal(task.state) || task.state === 'awaiting_approval') {
      return { state: task.state };
    }

    const runtime = await this.deps.resolver(task.agentId, task.agentVersion);
    const log = this.deps.logger.child({ taskId, agent: `${task.agentId}@${task.agentVersion}` });
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      const steps = await store.listSteps(taskId);
      const started = await store.transition(taskId, ['pending', 'running'], 'running');
      if (!started) return { state: (await store.getTask(taskId))?.state ?? task.state };
      await this.emit(
        ('task.' + (steps.length === 0 ? 'started' : 'resumed')) as TaskEventType,
        taskId,
        {
          steps: steps.length,
        },
      );
      const state = await this.loop(started, runtime, controller.signal, log);
      return { state };
    } catch (err) {
      if (err instanceof StepConflictError) {
        log.warn({ err: err.message }, 'task is being advanced by another worker; stopping');
        return { state: (await store.getTask(taskId))?.state ?? 'running' };
      }
      throw err;
    } finally {
      this.controllers.delete(taskId);
    }
  }

  private async loop(
    initial: AgentTask,
    runtime: AgentRuntime,
    signal: AbortSignal,
    log: Logger,
  ): Promise<TaskState> {
    const { store, provider } = this.deps;
    const { definition } = runtime;
    const taskId = initial.id;
    const toolsByName = new Map(runtime.tools.map((t) => [t.name, t]));
    const allowed = new Set(definition.tools);
    const toolSpecs: ToolSpec[] = runtime.tools
      .filter((t) => allowed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const rendered = (runtime.renderInput ?? defaultRenderInput)(initial.input);

    for (;;) {
      const task = await store.getTask(taskId);
      if (!task) throw new NotFoundError('task', taskId);
      if (task.cancelRequested || task.state === 'cancelled') {
        return this.finish(task, 'cancelled', {}, 'task.cancelled');
      }
      const steps = await store.listSteps(taskId);

      // 1. Tool calls requested by the model and not yet answered.
      const pending = pendingToolCalls(steps);
      const last = lastLlmStep(steps);

      if (pending.length === 0 && last && last.payload.toolCalls.length === 0) {
        const text = last.payload.content;
        return this.finish(
          task,
          'completed',
          { result: { text, json: tryParseJson(text) } },
          'task.completed',
        );
      }

      // 2. Budget gate: never start new work (a model call, or a tool call) once exhausted.
      if (task.tokensUsed >= task.tokenBudget) {
        return this.finish(
          task,
          'budget_exceeded',
          { error: `Token budget of ${task.tokenBudget} reached (${task.tokensUsed} used)` },
          'task.budget_exceeded',
        );
      }

      const next = pending[0];
      if (next) {
        // One tool call per iteration: each result is a new step, and the loop reloads
        // the log (cancellation, budget) before the next one.
        const suspended = await this.handleToolCall(
          task,
          next,
          steps.length,
          toolsByName,
          allowed,
          log,
          signal,
        );
        if (suspended) return 'awaiting_approval';
        continue;
      }

      // 3. A new model call.
      const llmCalls = steps.filter((s) => s.kind === 'llm').length;
      if (llmCalls >= definition.maxSteps) {
        return this.finish(
          task,
          'failed',
          { error: `Exceeded maxSteps (${definition.maxSteps})` },
          'task.failed',
        );
      }
      const messages = buildMessages(definition, rendered, steps);
      const estimate = estimateInputTokens(messages, toolSpecs);
      if (task.tokensUsed + estimate > task.tokenBudget) {
        return this.finish(
          task,
          'budget_exceeded',
          {
            error: `Next call needs about ${estimate} input tokens; ${task.tokenBudget - task.tokensUsed} left in budget`,
          },
          'task.budget_exceeded',
        );
      }

      const request: LLMRequest = {
        messages,
        signal,
        ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
        ...(definition.model ? { model: definition.model } : {}),
        ...(definition.routing
          ? {
              hints: {
                taskType: definition.routing.taskType,
                ...(definition.routing.complexity
                  ? { complexity: definition.routing.complexity }
                  : {}),
              },
            }
          : {}),
      };

      let response;
      try {
        response = await retryTransient(() => provider.complete(request), {
          ...this.deps.retry,
          signal,
          onRetry: ({ attempt, delayMs, error }) => {
            log.warn({ attempt, delayMs, kind: error.kind }, 'transient LLM error, retrying');
            this.deps.hooks?.onLlmRetry?.({ taskId, attempt, delayMs, kind: error.kind });
            void this.emit('task.retry', taskId, { attempt, delayMs, kind: error.kind });
          },
        });
      } catch (err) {
        if (err instanceof LLMError) {
          const fresh = await store.getTask(taskId);
          if (err.kind === 'aborted' && fresh) {
            return this.finish(fresh, 'cancelled', {}, 'task.cancelled');
          }
          log.error({ kind: err.kind, retryable: err.retryable }, 'LLM call failed');
          return this.finish(
            task,
            'failed',
            {
              error: `LLM error (${err.kind}${err.retryable ? ', retries exhausted' : ''}): ${err.message}`,
            },
            'task.failed',
          );
        }
        throw err;
      }

      const payload: LlmStepPayload = {
        content: response.content,
        toolCalls: response.toolCalls,
        model: response.model,
        latencyMs: response.latencyMs,
        simulated: response.simulated,
        ...(response.cached ? { cached: true } : {}),
      };
      const step = await store.appendStep(taskId, steps.length + 1, {
        kind: 'llm',
        payload,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      await this.emit('task.step', taskId, {
        seq: step.seq,
        kind: 'llm',
        model: response.model,
        toolCalls: response.toolCalls.map((c) => c.name),
        tokens: response.usage.inputTokens + response.usage.outputTokens,
      });
    }
  }

  /** Returns true when the task was suspended to wait for a human. */
  private async handleToolCall(
    task: AgentTask,
    pending: {
      call: { id: string; name: string; arguments: Record<string, unknown> };
      stepSeq: number;
    },
    stepCount: number,
    toolsByName: Map<string, AnyTool>,
    allowed: Set<string>,
    log: Logger,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { store } = this.deps;
    const { call, stepSeq } = pending;
    const record = async (
      content: string,
      isError: boolean,
      outcome: ToolOutcome,
    ): Promise<void> => {
      const payload: ToolStepPayload = {
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
        content,
        isError,
        outcome,
      };
      const step = await store.appendStep(task.id, stepCount + 1, { kind: 'tool', payload });
      this.deps.hooks?.onToolCall?.({ taskId: task.id, tool: call.name, outcome });
      await this.emit('task.step', task.id, {
        seq: step.seq,
        kind: 'tool',
        tool: call.name,
        outcome,
        isError,
      });
    };

    const tool = toolsByName.get(call.name);
    if (!tool || !allowed.has(call.name)) {
      await record(`Unknown tool "${call.name}"`, true, 'rejected');
      return false;
    }
    const validation = validateJsonSchema(tool.inputSchema, call.arguments);
    if (!validation.valid) {
      await record(`Invalid arguments: ${validation.errors.join('; ')}`, true, 'rejected');
      return false;
    }

    // Human approval for anything with an effect.
    if (tool.risk !== 'read') {
      const approval =
        (await store.findApproval(task.id, stepSeq, call.id)) ??
        (await store.createApproval({
          taskId: task.id,
          stepSeq,
          toolCallId: call.id,
          toolName: tool.name,
          arguments: call.arguments,
          risk: tool.risk,
        }));
      if (approval.status === 'pending') {
        const moved = await store.transition(task.id, ['running'], 'awaiting_approval');
        if (moved) {
          await this.emit('task.awaiting_approval', task.id, {
            approvalId: approval.id,
            tool: tool.name,
            risk: tool.risk,
          });
        }
        return true;
      }
      if (approval.status === 'denied') {
        await record(
          `The call was declined by a human reviewer${approval.reason ? `: ${approval.reason}` : '.'} Do not retry it.`,
          true,
          'denied',
        );
        return false;
      }
    }

    const key = {
      taskId: task.id,
      stepSeq,
      argsHash: sha256(canonicalJson({ name: call.name, arguments: call.arguments })),
    };
    const begun = await store.beginToolExecution(key, { toolName: tool.name, risk: tool.risk });
    if (!begun.inserted) {
      if (begun.record.status === 'completed') {
        await record(begun.record.result ?? '', begun.record.isError, 'replayed');
        return false;
      }
      if (tool.risk !== 'read') {
        // Started, never completed: a previous run may have performed the effect.
        // At-most-once is the safe choice; the agent is told the outcome is unknown.
        log.warn({ tool: tool.name }, 'tool execution was interrupted earlier; not re-running');
        await record(
          'A previous attempt of this call was interrupted and its outcome is unknown. It was not re-executed. Verify the current state before deciding whether to retry.',
          true,
          'unknown',
        );
        return false;
      }
      // read tools are safe to run again; fall through
    }

    let content: string;
    let isError = false;
    try {
      const output = await tool.execute(call.arguments, {
        taskId: task.id,
        idempotencyKey: `${key.taskId}:${key.stepSeq}:${key.argsHash}`,
        signal,
        logger: log,
      });
      content = typeof output === 'string' ? output : JSON.stringify(output);
    } catch (err) {
      isError = true;
      content = err instanceof Error ? err.message : String(err);
    }
    await store.completeToolExecution(key, content, isError);
    await record(content, isError, 'executed');
    return false;
  }

  private async finish(
    task: AgentTask,
    state: TaskState,
    patch: { result?: unknown; error?: string },
    event: TaskEventType,
  ): Promise<TaskState> {
    const updated = await this.deps.store.transition(
      task.id,
      ['pending', 'running', 'awaiting_approval'],
      state,
      patch,
    );
    if (!updated) return (await this.deps.store.getTask(task.id))?.state ?? state;
    this.deps.logger.info({ taskId: task.id, state }, 'task finished');
    this.deps.hooks?.onTaskFinished?.(updated, state);
    await this.emit(event, task.id, { state, ...(patch.error ? { error: patch.error } : {}) });
    return state;
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

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

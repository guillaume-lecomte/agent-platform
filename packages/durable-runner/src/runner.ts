import {
  LLMError,
  canonicalJson,
  estimateInputTokens,
  sha256,
  validateJsonSchema,
  withSpan,
  type AgentDefinition,
  type AnyTool,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type Logger,
  type ToolSpec,
} from '@agent-platform/core';
import { NotFoundError, StepConflictError } from './errors.js';
import { publishEvent, type EventBus } from './events.js';
import {
  buildMessages,
  defaultRenderInput,
  lastLlmStep,
  pendingToolCalls,
  type PendingToolCall,
} from './messages.js';
import { retryTransient, type RetryOptions } from './retry.js';
import type { TaskStore } from './store.js';
import {
  isTerminal,
  type AgentTask,
  type TaskStep,
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

/** What the loop needs about one run of one task, computed once. */
interface Run {
  taskId: string;
  runtime: AgentRuntime;
  tools: Map<string, AnyTool>;
  allowed: Set<string>;
  toolSpecs: ToolSpec[];
  firstMessage: string;
  signal: AbortSignal;
  log: Logger;
}

/**
 * Advances a task until it finishes, needs a human approval, or is stopped. All progress lives
 * in the store, so calling it again (after a crash, an approval...) continues from the last step.
 */
export class AgentRunner {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: RunnerDeps) {}

  /** Aborts the in-flight model call of a task running in this process, if any. */
  abortLocal(taskId: string): void {
    this.controllers.get(taskId)?.abort();
  }

  async advance(taskId: string): Promise<AdvanceResult> {
    const { store } = this.deps;
    const task = await store.getTask(taskId);
    if (!task) throw new NotFoundError('task', taskId);
    // awaiting_approval tasks only move through the approval flow.
    if (isTerminal(task.state) || task.state === 'awaiting_approval') {
      return { state: task.state };
    }

    const runtime = await this.deps.resolver(task.agentId, task.agentVersion);
    const log = this.deps.logger.child({ taskId, agent: `${task.agentId}@${task.agentVersion}` });
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      const stepCount = (await store.listSteps(taskId)).length;
      const started = await store.transition(taskId, ['pending', 'running'], 'running');
      if (!started) return { state: (await store.getTask(taskId))?.state ?? task.state };
      await this.emit(stepCount === 0 ? 'task.started' : 'task.resumed', taskId, {
        steps: stepCount,
      });

      const allowed = new Set(runtime.definition.tools);
      const run: Run = {
        taskId,
        runtime,
        tools: new Map(runtime.tools.map((t) => [t.name, t])),
        allowed,
        toolSpecs: runtime.tools
          .filter((t) => allowed.has(t.name))
          .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        firstMessage: (runtime.renderInput ?? defaultRenderInput)(started.input),
        signal: controller.signal,
        log,
      };
      for (;;) {
        const state = await this.iterate(run);
        if (state) return { state };
      }
    } catch (err) {
      if (err instanceof StepConflictError) {
        // Another worker wrote the step we were about to write: let it carry on.
        log.warn({ err: err.message }, 'task is being advanced by another worker; stopping');
        return { state: (await store.getTask(taskId))?.state ?? 'running' };
      }
      throw err;
    } finally {
      this.controllers.delete(taskId);
    }
  }

  /** One pass of the loop. Returns the state to stop in, or undefined to go around again. */
  private async iterate(run: Run): Promise<TaskState | undefined> {
    const { store } = this.deps;
    const task = await store.getTask(run.taskId);
    if (!task) throw new NotFoundError('task', run.taskId);
    if (task.cancelRequested || task.state === 'cancelled') {
      return this.finish(task, 'cancelled', {}, 'task.cancelled');
    }
    const steps = await store.listSteps(run.taskId);
    const pending = pendingToolCalls(steps);
    const last = lastLlmStep(steps);

    // The last model turn asked for nothing more: that is the answer.
    if (pending.length === 0 && last && last.payload.toolCalls.length === 0) {
      const text = last.payload.content;
      return this.finish(
        task,
        'completed',
        { result: { text, json: tryParseJson(text) } },
        'task.completed',
      );
    }

    // Once the budget is gone, nothing new starts: neither a model call nor a tool call.
    if (task.tokensUsed >= task.tokenBudget) {
      return this.finish(
        task,
        'budget_exceeded',
        { error: `Token budget of ${task.tokenBudget} reached (${task.tokensUsed} used)` },
        'task.budget_exceeded',
      );
    }

    // Tool calls run one at a time; each result is a step, and the loop re-reads the log
    // (cancellation, budget) before the next one.
    const next = pending[0];
    if (next) {
      const suspended = await this.runToolCall(run, task, next, steps.length + 1);
      return suspended ? 'awaiting_approval' : undefined;
    }
    return this.callModel(run, task, steps);
  }

  private async callModel(
    run: Run,
    task: AgentTask,
    steps: TaskStep[],
  ): Promise<TaskState | undefined> {
    const { store } = this.deps;
    const { definition } = run.runtime;

    if (steps.filter((s) => s.kind === 'llm').length >= definition.maxSteps) {
      return this.finish(
        task,
        'failed',
        { error: `Exceeded maxSteps (${definition.maxSteps})` },
        'task.failed',
      );
    }
    const messages = buildMessages(definition, run.firstMessage, steps);
    const estimate = estimateInputTokens(messages, run.toolSpecs);
    const remaining = task.tokenBudget - task.tokensUsed;
    if (estimate > remaining) {
      return this.finish(
        task,
        'budget_exceeded',
        { error: `Next call needs about ${estimate} input tokens; ${remaining} left in budget` },
        'task.budget_exceeded',
      );
    }

    const request: LLMRequest = {
      messages,
      signal: run.signal,
      tools: run.toolSpecs.length > 0 ? run.toolSpecs : undefined,
      model: definition.model,
      hints: definition.routing,
      metadata: { taskId: task.id, agentId: task.agentId, agentVersion: task.agentVersion },
    };

    let response: LLMResponse;
    try {
      response = await retryTransient(
        () =>
          withSpan('llm.complete', { 'task.id': task.id, 'agent.id': task.agentId }, () =>
            this.deps.provider.complete(request),
          ),
        {
          ...this.deps.retry,
          signal: run.signal,
          onRetry: ({ attempt, delayMs, error }) => {
            run.log.warn({ attempt, delayMs, kind: error.kind }, 'transient LLM error, retrying');
            this.deps.hooks?.onLlmRetry?.({ taskId: task.id, attempt, delayMs, kind: error.kind });
            void this.emit('task.retry', task.id, { attempt, delayMs, kind: error.kind });
          },
        },
      );
    } catch (err) {
      if (!(err instanceof LLMError)) throw err;
      if (err.kind === 'aborted') {
        const fresh = await store.getTask(task.id);
        if (fresh) return this.finish(fresh, 'cancelled', {}, 'task.cancelled');
      }
      run.log.error({ kind: err.kind, retryable: err.retryable }, 'LLM call failed');
      const exhausted = err.retryable ? ', retries exhausted' : '';
      return this.finish(
        task,
        'failed',
        { error: `LLM error (${err.kind}${exhausted}): ${err.message}` },
        'task.failed',
      );
    }

    const step = await store.appendStep(task.id, steps.length + 1, {
      kind: 'llm',
      payload: {
        content: response.content,
        toolCalls: response.toolCalls,
        model: response.model,
        latencyMs: response.latencyMs,
        simulated: response.simulated,
        cached: response.cached,
      },
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    await this.emit('task.step', task.id, {
      seq: step.seq,
      kind: 'llm',
      model: response.model,
      toolCalls: response.toolCalls.map((c) => c.name),
      tokens: response.usage.inputTokens + response.usage.outputTokens,
    });
    return undefined;
  }

  /**
   * Handles one tool call requested by the model, and records its result as the next step.
   * Returns true when the task was suspended to wait for a human.
   */
  private async runToolCall(
    run: Run,
    task: AgentTask,
    { call, stepSeq }: PendingToolCall,
    nextSeq: number,
  ): Promise<boolean> {
    const { store } = this.deps;
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
      const step = await store.appendStep(task.id, nextSeq, { kind: 'tool', payload });
      this.deps.hooks?.onToolCall?.({ taskId: task.id, tool: call.name, outcome });
      await this.emit('task.step', task.id, {
        seq: step.seq,
        kind: 'tool',
        tool: call.name,
        outcome,
        isError,
      });
    };

    const tool = run.tools.get(call.name);
    if (!tool || !run.allowed.has(call.name)) {
      await record(`Unknown tool "${call.name}"`, true, 'rejected');
      return false;
    }
    const validation = validateJsonSchema(tool.inputSchema, call.arguments);
    if (!validation.valid) {
      await record(`Invalid arguments: ${validation.errors.join('; ')}`, true, 'rejected');
      return false;
    }

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
        const why = approval.reason ? `: ${approval.reason}` : '.';
        await record(
          `The call was declined by a human reviewer${why} Do not retry it.`,
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
        // Registered but never completed: the effect may or may not have happened. Running it
        // again could repeat it, so tell the agent instead (ADR 0005).
        run.log.warn({ tool: tool.name }, 'tool execution was interrupted earlier; not re-running');
        await record(
          'A previous attempt of this call was interrupted and its outcome is unknown. It was not re-executed. Verify the current state before deciding whether to retry.',
          true,
          'unknown',
        );
        return false;
      }
      // A read tool is safe to run again.
    }

    let content: string;
    let isError = false;
    try {
      const output = await withSpan(
        'tool.execute',
        { 'task.id': task.id, 'tool.name': tool.name, 'tool.risk': tool.risk },
        () =>
          tool.execute(call.arguments, {
            taskId: task.id,
            idempotencyKey: `${key.taskId}:${key.stepSeq}:${key.argsHash}`,
            signal: run.signal,
            logger: run.log,
          }),
      );
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
    const { store, logger, hooks } = this.deps;
    const updated = await store.transition(
      task.id,
      ['pending', 'running', 'awaiting_approval'],
      state,
      patch,
    );
    if (!updated) return (await store.getTask(task.id))?.state ?? state;
    logger.info({ taskId: task.id, state }, 'task finished');
    hooks?.onTaskFinished?.(updated, state);
    await this.emit(event, task.id, { state, error: patch.error });
    return state;
  }

  private emit(type: TaskEventType, taskId: string, data?: Record<string, unknown>): Promise<void> {
    return publishEvent(this.deps.bus, this.deps.logger, type, taskId, data);
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

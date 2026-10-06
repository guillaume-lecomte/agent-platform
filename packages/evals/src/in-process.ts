import { createLogger, type LLMProvider } from '@agent-platform/core';
import {
  AgentRunner,
  InMemoryEventBus,
  InMemoryTaskStore,
  type LlmStepPayload,
} from '@agent-platform/durable-runner';
import { randomUUID } from 'node:crypto';
import type { RegisteredAgent } from './agents.js';
import type { AgentExecutor, AgentRun } from './types.js';

export interface InProcessOptions {
  agent: RegisteredAgent;
  version: string;
  provider: LLMProvider;
  /** Overrides the model named by the agent definition (used by the routing benchmark). */
  model?: string;
}

const silent = createLogger({ name: 'evals', level: 'silent' });

/**
 * Runs an agent to completion in this process, on an in-memory store, approving every
 * human-approval request automatically. Same runner and same loop as production, which
 * is the point: evals exercise the real agent code path.
 */
export function createInProcessExecutor(options: InProcessOptions): AgentExecutor {
  return async (input: unknown): Promise<AgentRun> => {
    const runtime = await options.agent.createRuntime(options.version);
    const definition = options.model
      ? { ...runtime.definition, model: options.model }
      : runtime.definition;
    const store = new InMemoryTaskStore();
    const runner = new AgentRunner({
      store,
      provider: options.provider,
      resolver: async () => ({ ...runtime, definition }),
      bus: new InMemoryEventBus(),
      logger: silent,
    });
    const { task } = await store.createTask({
      idempotencyKey: randomUUID(),
      agentId: options.agent.id,
      agentVersion: options.version,
      input: runtime.validateInput ? runtime.validateInput(input) : input,
      tokenBudget: definition.tokenBudget,
    });

    let state = (await runner.advance(task.id)).state;
    for (let guard = 0; state === 'awaiting_approval' && guard < 50; guard++) {
      for (const approval of await store.listApprovals({ taskId: task.id, status: 'pending' })) {
        await store.decideApproval(approval.id, 'approved', 'automatic approval in evals');
      }
      await store.transition(task.id, ['awaiting_approval'], 'pending');
      state = (await runner.advance(task.id)).state;
    }

    const final = await store.getTask(task.id);
    const steps = await store.listSteps(task.id);
    const llmSteps = steps.filter((s) => s.kind === 'llm');
    const result = final?.result as { text?: string; json?: unknown } | null;
    return {
      finalText: result?.text ?? null,
      output: result?.json ?? null,
      toolCalls: llmSteps.flatMap((s) =>
        (s.payload as LlmStepPayload).toolCalls.map((c) => ({
          name: c.name,
          arguments: c.arguments,
        })),
      ),
      state,
      ...(final?.error ? { error: final.error } : {}),
      usage: {
        inputTokens: llmSteps.reduce((n, s) => n + s.inputTokens, 0),
        outputTokens: llmSteps.reduce((n, s) => n + s.outputTokens, 0),
        llmCalls: llmSteps.length,
      },
      latencyMs: llmSteps.reduce((n, s) => n + (s.payload as LlmStepPayload).latencyMs, 0),
      models: [...new Set(llmSteps.map((s) => (s.payload as LlmStepPayload).model))],
      simulated: llmSteps.some((s) => (s.payload as LlmStepPayload).simulated),
    };
  };
}

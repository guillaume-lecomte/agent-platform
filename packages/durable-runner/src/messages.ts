import type { AgentDefinition, Message, ToolCall } from '@agent-platform/core';
import type { LlmStepPayload, TaskStep, ToolStepPayload } from './types.js';

export interface PendingToolCall {
  call: ToolCall;
  /** Seq of the LLM step that requested it. */
  stepSeq: number;
}

/**
 * Rebuilds the conversation from persisted steps. The step log is the single source of
 * truth: nothing else is needed to resume a task after a crash.
 */
export function buildMessages(
  definition: Pick<AgentDefinition, 'systemPrompt'>,
  renderedInput: string,
  steps: TaskStep[],
): Message[] {
  const messages: Message[] = [
    { role: 'system', content: definition.systemPrompt },
    { role: 'user', content: renderedInput },
  ];
  for (const step of steps) {
    if (step.kind === 'llm') {
      const p = step.payload as LlmStepPayload;
      messages.push({
        role: 'assistant',
        content: p.content,
        ...(p.toolCalls.length > 0 ? { toolCalls: p.toolCalls } : {}),
      });
    } else {
      const p = step.payload as ToolStepPayload;
      messages.push({
        role: 'tool',
        toolCallId: p.toolCallId,
        name: p.name,
        content: p.content,
        ...(p.isError ? { isError: true } : {}),
      });
    }
  }
  return messages;
}

/** Tool calls requested by the latest LLM step that have no recorded result yet. */
export function pendingToolCalls(steps: TaskStep[]): PendingToolCall[] {
  let last: TaskStep | undefined;
  for (const s of steps) if (s.kind === 'llm') last = s;
  if (!last) return [];
  const answered = new Set(
    steps
      .filter((s) => s.kind === 'tool' && s.seq > last.seq)
      .map((s) => (s.payload as ToolStepPayload).toolCallId),
  );
  return (last.payload as LlmStepPayload).toolCalls
    .filter((c) => !answered.has(c.id))
    .map((call) => ({ call, stepSeq: last.seq }));
}

export function lastLlmStep(steps: TaskStep[]): TaskStep<LlmStepPayload> | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.kind === 'llm') return s as TaskStep<LlmStepPayload>;
  }
  return undefined;
}

export function defaultRenderInput(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

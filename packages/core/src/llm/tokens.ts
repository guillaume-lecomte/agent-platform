import type { Message, ToolSpec, Usage } from './types.js';

/**
 * Deterministic token estimate (~4 characters per token). Real providers report exact
 * usage; this is only used by the mock provider and for budget pre-checks.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateInputTokens(messages: Message[], tools: ToolSpec[] = []): number {
  const body = messages.map((m) => JSON.stringify(m)).join('\n') + JSON.stringify(tools);
  return estimateTokens(body);
}

export function estimateUsage(
  messages: Message[],
  tools: ToolSpec[] | undefined,
  output: string,
): Usage {
  return {
    inputTokens: estimateInputTokens(messages, tools),
    outputTokens: estimateTokens(output),
  };
}

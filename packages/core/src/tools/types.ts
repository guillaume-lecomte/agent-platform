import type { JsonSchema } from '../llm/types.js';
import type { Logger } from '../logger.js';

/**
 * read:        no side effect, safe to re-run.
 * reversible:  has an effect that can be undone (e.g. add a label).
 * destructive: has an effect that cannot be undone (e.g. post a comment, delete data).
 * Anything other than `read` requires human approval in the durable runner.
 */
export type RiskLevel = 'read' | 'reversible' | 'destructive';

export interface ToolContext {
  taskId?: string;
  /**
   * Stable key for this exact call (task + step + argument hash). Tools that call
   * external systems should forward it so the downstream system can deduplicate too.
   */
  idempotencyKey: string;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface Tool<Input = Record<string, unknown>, Output = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: RiskLevel;
  execute(input: Input, context: ToolContext): Promise<Output>;
}

export type AnyTool = Tool<any, unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any -- registries hold tools of heterogeneous input types

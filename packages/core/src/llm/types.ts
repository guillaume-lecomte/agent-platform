/** Provider-neutral message and request types used across the platform. */

export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  /** Provider-assigned (or mock-assigned) identifier, unique within a conversation. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type Complexity = 'low' | 'medium' | 'high';

/** Optional hints used by the cost router; providers ignore them. */
export interface RoutingHints {
  taskType?: string;
  complexity?: Complexity;
  /** Set to false to bypass the response cache for this request. */
  cache?: boolean;
}

export interface LLMRequest {
  /** Explicit model. When omitted, a router (or the provider default) picks one. */
  model?: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
  hints?: RoutingHints;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens';

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage: Usage;
  stopReason: StopReason;
  /** Wall-clock latency, or the simulated latency when `simulated` is true. */
  latencyMs: number;
  /** True when the provider is a test double (latency and tokens are not measured). */
  simulated: boolean;
  /** True when the response was served from a cache instead of a model call. */
  cached?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

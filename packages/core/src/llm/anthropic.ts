import Anthropic from '@anthropic-ai/sdk';
import { toLLMError } from './errors.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  Message,
  StopReason,
  ToolCall,
} from './types.js';

/** The slice of the Anthropic client this provider uses; lets tests inject a fake. */
export interface AnthropicLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: string }
      >;
      model: string;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  defaultModel: string;
  client?: AnthropicLike;
  defaultMaxTokens?: number;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Converts neutral messages to the Messages API shape (system split out, tool results batched). */
export function toAnthropicMessages(messages: Message[]): {
  system: string | undefined;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }>;
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : '' });
    } else {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && Array.isArray(prev.content)) prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return { system: system || undefined, messages: out };
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
};

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: AnthropicLike;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.client =
      options.client ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicLike);
    this.defaultModel = options.defaultModel;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel;
    const { system, messages } = toAnthropicMessages(request.messages);
    const params: Record<string, unknown> = {
      model,
      max_tokens: request.maxOutputTokens ?? this.defaultMaxTokens,
      messages,
    };
    if (system) params.system = system;
    if (request.temperature !== undefined) params.temperature = request.temperature;
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const started = performance.now();
    try {
      const res = await this.client.messages.create(
        params,
        request.signal ? { signal: request.signal } : undefined,
      );
      const toolCalls: ToolCall[] = [];
      let content = '';
      for (const block of res.content) {
        if (block.type === 'text') content += (block as { text: string }).text;
        if (block.type === 'tool_use') {
          const b = block as { id: string; name: string; input: unknown };
          toolCalls.push({
            id: b.id,
            name: b.name,
            arguments: (b.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      return {
        content,
        toolCalls,
        model: res.model,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        stopReason: STOP[res.stop_reason ?? 'end_turn'] ?? 'end',
        latencyMs: Math.round(performance.now() - started),
        simulated: false,
      };
    } catch (err) {
      throw toLLMError(err, this.name);
    }
  }
}

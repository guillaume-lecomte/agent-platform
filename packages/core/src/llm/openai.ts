import OpenAI from 'openai';
import { toLLMError } from './errors.js';
import type { LLMProvider, LLMRequest, LLMResponse, Message, ToolCall } from './types.js';

/** The slice of the OpenAI client this provider uses; lets tests inject a fake. */
export interface OpenAILike {
  responses: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      model: string;
      output: Array<
        | { type: 'message'; content: Array<{ type: string; text?: string }> }
        | { type: 'function_call'; call_id: string; name: string; arguments: string }
        | { type: string }
      >;
      usage?: { input_tokens: number; output_tokens: number } | null;
      incomplete_details?: { reason?: string } | null;
    }>;
  };
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  defaultModel: string;
  client?: OpenAILike;
}

type InputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** Converts neutral messages to Responses API input items (system becomes `instructions`). */
export function toOpenAIInput(messages: Message[]): {
  instructions: string | undefined;
  input: InputItem[];
} {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const input: InputItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') input.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const c of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.arguments),
        });
      }
    } else {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.isError ? `ERROR: ${m.content}` : m.content,
      });
    }
  }
  return { instructions: instructions || undefined, input };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private readonly client: OpenAILike;
  private readonly defaultModel: string;

  constructor(options: OpenAIProviderOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.defaultModel = options.defaultModel;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.defaultModel;
    const { instructions, input } = toOpenAIInput(request.messages);
    const params: Record<string, unknown> = { model, input };
    if (instructions) params.instructions = instructions;
    if (request.maxOutputTokens !== undefined) params.max_output_tokens = request.maxOutputTokens;
    if (request.temperature !== undefined) params.temperature = request.temperature;
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      }));
    }

    const started = performance.now();
    try {
      const res = await this.client.responses.create(
        params,
        request.signal ? { signal: request.signal } : undefined,
      );
      let content = '';
      const toolCalls: ToolCall[] = [];
      for (const item of res.output) {
        if (item.type === 'message') {
          for (const part of (item as { content: Array<{ type: string; text?: string }> })
            .content) {
            if (part.type === 'output_text' && part.text) content += part.text;
          }
        } else if (item.type === 'function_call') {
          const c = item as { call_id: string; name: string; arguments: string };
          toolCalls.push({
            id: c.call_id,
            name: c.name,
            arguments: parseArguments(c.arguments),
          });
        }
      }
      return {
        content,
        toolCalls,
        model: res.model,
        usage: {
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
        },
        stopReason:
          toolCalls.length > 0
            ? 'tool_use'
            : res.incomplete_details?.reason === 'max_output_tokens'
              ? 'max_tokens'
              : 'end',
        latencyMs: Math.round(performance.now() - started),
        simulated: false,
      };
    } catch (err) {
      throw toLLMError(err, this.name);
    }
  }
}

/**
 * Models occasionally return malformed JSON arguments. Keep the raw text instead of throwing:
 * schema validation in the runner then rejects the call and tells the model what was wrong.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

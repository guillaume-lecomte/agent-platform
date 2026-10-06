import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  LLMError,
  OpenAIProvider,
  toAnthropicMessages,
  toLLMError,
  toOpenAIInput,
  type AnthropicLike,
  type Message,
  type OpenAILike,
} from '../src/index.js';

const conversation: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: 'looking',
    toolCalls: [
      { id: 'c1', name: 'a', arguments: { x: 1 } },
      { id: 'c2', name: 'b', arguments: {} },
    ],
  },
  { role: 'tool', toolCallId: 'c1', name: 'a', content: '{"ok":true}' },
  { role: 'tool', toolCallId: 'c2', name: 'b', content: 'boom', isError: true },
];

describe('Anthropic adapter', () => {
  it('splits system, and batches consecutive tool results into one user turn', () => {
    const { system, messages } = toAnthropicMessages(conversation);
    expect(system).toBe('sys');
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } },
        { type: 'tool_use', id: 'c2', name: 'b', input: {} },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'boom', is_error: true },
      ],
    });
  });

  it('maps a tool_use response and usage', async () => {
    let seen: Record<string, unknown> = {};
    const client: AnthropicLike = {
      messages: {
        async create(params) {
          seen = params;
          return {
            content: [
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 't1', name: 'a', input: { y: 2 } },
            ],
            model: 'claude-x',
            stop_reason: 'tool_use',
            usage: { input_tokens: 11, output_tokens: 7 },
          };
        },
      },
    };
    const provider = new AnthropicProvider({ client, defaultModel: 'claude-x' });
    const res = await provider.complete({
      messages: conversation,
      tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(seen.model).toBe('claude-x');
    expect(seen.tools).toEqual([{ name: 'a', description: 'd', input_schema: { type: 'object' } }]);
    expect(res).toMatchObject({
      content: 'ok',
      stopReason: 'tool_use',
      usage: { inputTokens: 11, outputTokens: 7 },
      simulated: false,
    });
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'a', arguments: { y: 2 } }]);
  });

  it('wraps SDK errors in typed LLMErrors', async () => {
    const client: AnthropicLike = {
      messages: {
        async create() {
          throw Object.assign(new Error('too many'), { name: 'RateLimitError', status: 429 });
        },
      },
    };
    const provider = new AnthropicProvider({ client, defaultModel: 'm' });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    });
  });
});

describe('OpenAI adapter', () => {
  it('uses instructions plus function_call / function_call_output items', () => {
    const { instructions, input } = toOpenAIInput(conversation);
    expect(instructions).toBe('sys');
    expect(input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'looking' },
      { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{"x":1}' },
      { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
      { type: 'function_call_output', call_id: 'c2', output: 'ERROR: boom' },
    ]);
  });

  it('parses function calls and usage from a Responses API answer', async () => {
    const client: OpenAILike = {
      responses: {
        async create() {
          return {
            model: 'gpt-x',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
              { type: 'function_call', call_id: 'f1', name: 'a', arguments: '{"z":3}' },
            ],
            usage: { input_tokens: 20, output_tokens: 9 },
          };
        },
      },
    };
    const res = await new OpenAIProvider({ client, defaultModel: 'gpt-x' }).complete({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(res).toMatchObject({ content: 'done', stopReason: 'tool_use' });
    expect(res.toolCalls).toEqual([{ id: 'f1', name: 'a', arguments: { z: 3 } }]);
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 9 });
  });
});

describe('toLLMError', () => {
  it.each([
    [{ status: 429 }, 'rate_limit', true],
    [{ status: 503 }, 'overloaded', true],
    [{ status: 500 }, 'server', true],
    [{ status: 401 }, 'authentication', false],
    [{ status: 400, message: 'prompt is too long' }, 'context_length', false],
    [{ status: 400, message: 'bad field' }, 'invalid_request', false],
    [{ name: 'APIConnectionError' }, 'network', true],
    [{ name: 'APIConnectionTimeoutError' }, 'timeout', true],
  ])('maps %j to %s (retryable=%s)', (input, kind, retryable) => {
    const err = toLLMError(
      Object.assign(new Error(input['message' as keyof typeof input] ?? 'x'), input),
      'p',
    );
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
  });

  it('passes LLMErrors through unchanged', () => {
    const e = new LLMError('timeout', 't');
    expect(toLLMError(e, 'p')).toBe(e);
  });
});

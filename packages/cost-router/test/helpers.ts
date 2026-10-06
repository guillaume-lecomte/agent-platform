import {
  LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '@agent-platform/core';
import { parsePolicy, parsePricing } from '../src/index.js';

export const pricing = parsePricing(`
version: 1
updated: 2026-10-06
models:
  big:   { provider: p, input: 10, output: 50, source: test, retrieved: 2026-10-01 }
  small: { provider: p, input: 1, output: 5, source: test, retrieved: 2026-10-01 }
  other: { provider: q, input: 2, output: 2, source: test, retrieved: 2026-10-01 }
`);

export const policy = parsePolicy(`
version: 1
default: { model: big, fallback: small }
timeout_ms: 200
cache: { enabled: true, ttl_seconds: 60 }
complexity:
  input_chars: { medium: 100, high: 500 }
  tool_count: { medium: 3, high: 6 }
rules:
  - name: easy-triage
    when: { task_type: triage, complexity: [low] }
    model: small
    fallback: big
  - name: other-types
    when: { task_type: [a, b] }
    model: other
`);

export interface FakeProvider extends LLMProvider {
  calls: LLMRequest[];
  behaviour: (req: LLMRequest, n: number) => Promise<LLMResponse>;
}

export const answer = (model: string, over: Partial<LLMResponse> = {}): LLMResponse => ({
  content: `answer from ${model}`,
  toolCalls: [],
  model,
  usage: { inputTokens: 1000, outputTokens: 100 },
  stopReason: 'end',
  latencyMs: 250,
  simulated: false,
  ...over,
});

export function fakeProvider(
  behaviour?: (req: LLMRequest, n: number) => Promise<LLMResponse>,
): FakeProvider {
  const provider: FakeProvider = {
    name: 'fake',
    calls: [],
    behaviour: behaviour ?? (async (req) => answer(req.model ?? 'unknown')),
    async complete(req) {
      provider.calls.push(req);
      return provider.behaviour(req, provider.calls.length);
    },
  };
  return provider;
}

export const failing =
  (kind: ConstructorParameters<typeof LLMError>[0] = 'server') =>
  async (): Promise<LLMResponse> => {
    throw new LLMError(kind, `${kind} error`);
  };

export const user = (text: string): LLMRequest['messages'] => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: text },
];

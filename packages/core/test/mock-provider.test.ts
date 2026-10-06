import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LLMError,
  MockProvider,
  MockRecordingMissingError,
  hashRequest,
  type LLMProvider,
  type LLMRequest,
} from '../src/index.js';

const request: LLMRequest = {
  messages: [
    { role: 'system', content: 'You triage issues.' },
    { role: 'user', content: 'The app crashes on login' },
  ],
};

describe('MockProvider', () => {
  it('is deterministic: same request, same response', async () => {
    const provider = new MockProvider({ responder: () => ({ content: 'hello' }) });
    const a = await provider.complete(request);
    const b = await provider.complete(request);
    expect(a).toEqual(b);
    expect(a.simulated).toBe(true);
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(a.usage.outputTokens).toBeGreaterThan(0);
  });

  it('derives stable tool call ids and stop reason from the request hash', async () => {
    const provider = new MockProvider({
      responder: () => ({ toolCalls: [{ name: 'search', arguments: { q: 'x' } }] }),
    });
    const res = await provider.complete(request);
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls[0]?.id).toMatch(/^call_[0-9a-f]{8}_0$/);
    expect((await provider.complete(request)).toolCalls[0]?.id).toBe(res.toolCalls[0]?.id);
  });

  it('throws a typed error when nothing can answer', async () => {
    const provider = new MockProvider();
    await expect(provider.complete(request)).rejects.toBeInstanceOf(MockRecordingMissingError);
  });

  it('consumes scripted failures before answering', async () => {
    const provider = new MockProvider({ responder: () => ({ content: 'ok' }) });
    provider.failNext(new LLMError('rate_limit', 'slow down'));
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(provider.complete(request)).resolves.toMatchObject({ content: 'ok' });
  });

  it('records real answers, then replays them without the real provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mock-rec-'));
    let realCalls = 0;
    const real: LLMProvider = {
      name: 'real',
      async complete() {
        realCalls += 1;
        return {
          content: 'from the real model',
          toolCalls: [],
          model: 'real-model',
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end',
          latencyMs: 400,
          simulated: false,
        };
      },
    };
    const recorder = new MockProvider({ recordingsDir: dir, recordFrom: real });
    const first = await recorder.complete({ ...request, model: 'real-model' });
    expect(first.simulated).toBe(false);
    expect(realCalls).toBe(1);
    expect(await readdir(dir)).toEqual([`${hashRequest(request, 'real-model')}.json`]);

    const replayer = new MockProvider({ recordingsDir: dir });
    const replayed = await replayer.complete({ ...request, model: 'real-model' });
    expect(replayed.content).toBe('from the real model');
    expect(replayed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(replayed.simulated).toBe(true);
    expect(realCalls).toBe(1);
  });

  it('hashes the model into the request identity', () => {
    expect(hashRequest(request, 'a')).not.toBe(hashRequest(request, 'b'));
    expect(hashRequest({ ...request, hints: { cache: false } }, 'a')).toBe(
      hashRequest(request, 'a'),
    );
  });
});

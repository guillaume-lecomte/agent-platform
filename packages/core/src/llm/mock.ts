import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LLMError } from './errors.js';
import { hashRequest } from './hash.js';
import { estimateUsage } from './tokens.js';
import type { LLMProvider, LLMRequest, LLMResponse, StopReason, ToolCall, Usage } from './types.js';

/** What a responder returns: the assistant turn, without bookkeeping. */
export interface MockReply {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** Scripted behaviour standing in for a model. Return undefined to fall through. */
export type MockResponder = (
  request: LLMRequest & { model: string },
) => MockReply | undefined | Promise<MockReply | undefined>;

export interface MockProviderOptions {
  /** Model reported when the request does not name one. */
  defaultModel?: string;
  /** Directory of `<request-hash>.json` recordings checked before anything else. */
  recordingsDir?: string;
  /** Deterministic fallback used when no recording matches. */
  responder?: MockResponder;
  /** Record mode: on a recording miss, call this real provider and save the answer. */
  recordFrom?: LLMProvider;
  /** Simulated latency reported on responses. Nothing sleeps for it. */
  simulatedLatencyMs?: (model: string, usage: Usage) => number;
  /** Real delay (ms) applied to every call, to make long-running tasks observable. */
  realDelayMs?: number;
}

interface Recording {
  request: { model: string; messageCount: number; lastMessage: string };
  response: Pick<LLMResponse, 'content' | 'toolCalls' | 'model' | 'usage' | 'stopReason'>;
}

export class MockRecordingMissingError extends LLMError {
  constructor(hash: string, model: string) {
    super(
      'invalid_request',
      `MockProvider has no recording or responder for request ${hash.slice(0, 12)} (model ${model}). ` +
        'Provide a responder, add a recording, or run in record mode with a real provider key.',
    );
    this.name = 'MockRecordingMissingError';
  }
}

const defaultLatency = (_model: string, usage: Usage): number => 120 + usage.outputTokens * 6;

/**
 * Deterministic LLM test double. Same request in, same response out; no network.
 * Latency and token counts are simulated and flagged as such on every response.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  private readonly opts: MockProviderOptions;
  private readonly scriptedErrors: LLMError[] = [];
  callCount = 0;

  constructor(options: MockProviderOptions = {}) {
    this.opts = options;
  }

  /** Makes the next call(s) throw. Used to exercise retry and fallback logic. */
  failNext(...errors: LLMError[]): void {
    this.scriptedErrors.push(...errors);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.callCount += 1;
    if (this.opts.realDelayMs) await abortableSleep(this.opts.realDelayMs, request.signal);
    const scripted = this.scriptedErrors.shift();
    if (scripted) throw scripted;

    const model = request.model ?? this.opts.defaultModel ?? 'mock-large';
    const hash = hashRequest(request, model);

    const recorded = await this.readRecording(hash);
    if (recorded) return this.finish(recorded.response, model);

    if (this.opts.recordFrom) {
      const real = await this.opts.recordFrom.complete(request);
      await this.writeRecording(hash, request, real);
      return { ...real, simulated: false };
    }

    const reply = await this.opts.responder?.({ ...request, model });
    if (!reply) throw new MockRecordingMissingError(hash, model);

    const content = reply.content ?? '';
    const toolCalls: ToolCall[] = (reply.toolCalls ?? []).map((c, i) => ({
      id: `call_${hash.slice(0, 8)}_${i}`,
      name: c.name,
      arguments: c.arguments,
    }));
    const output = content + JSON.stringify(toolCalls);
    const usage = estimateUsage(request.messages, request.tools, output);
    return this.finish(
      {
        content,
        toolCalls,
        model,
        usage,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
      },
      model,
    );
  }

  private finish(
    base: Pick<LLMResponse, 'content' | 'toolCalls' | 'model' | 'usage' | 'stopReason'>,
    model: string,
  ): LLMResponse {
    const latency = (this.opts.simulatedLatencyMs ?? defaultLatency)(model, base.usage);
    return { ...base, model, latencyMs: latency, simulated: true };
  }

  private async readRecording(hash: string): Promise<Recording | undefined> {
    if (!this.opts.recordingsDir) return undefined;
    try {
      const text = await readFile(join(this.opts.recordingsDir, `${hash}.json`), 'utf8');
      return JSON.parse(text) as Recording;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async writeRecording(
    hash: string,
    request: LLMRequest,
    response: LLMResponse,
  ): Promise<void> {
    if (!this.opts.recordingsDir) return;
    await mkdir(this.opts.recordingsDir, { recursive: true });
    const last = request.messages[request.messages.length - 1];
    const stopReason: StopReason = response.stopReason;
    const recording: Recording = {
      request: {
        model: response.model,
        messageCount: request.messages.length,
        lastMessage: last && 'content' in last ? last.content.slice(0, 200) : '',
      },
      response: {
        content: response.content,
        toolCalls: response.toolCalls,
        model: response.model,
        usage: response.usage,
        stopReason,
      },
    };
    await writeFile(
      join(this.opts.recordingsDir, `${hash}.json`),
      JSON.stringify(recording, null, 2) + '\n',
    );
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LLMError('aborted', 'Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LLMError('aborted', 'Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

import {
  LLMError,
  hashRequest,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type Logger,
} from '@agent-platform/core';
import type { CacheEntry, ResponseCache } from './cache.js';
import { decideRoute, validatePolicy, type Route, type RoutingPolicy } from './policy.js';
import { computeCost, priceOf, type PricingTable } from './pricing.js';
import type { CallTracker } from './tracker.js';

export interface CostRouterOptions {
  /** One provider per `provider` name used in the pricing file. */
  providers: Record<string, LLMProvider>;
  pricing: PricingTable;
  policy: RoutingPolicy;
  cache?: ResponseCache;
  tracker?: CallTracker;
  logger?: Logger;
}

/**
 * An LLMProvider that chooses the model: it applies the routing policy, serves exact repeats
 * from a cache, falls back to another model on error or timeout, and records the cost and
 * latency of every attempt.
 */
export class CostRouter implements LLMProvider {
  readonly name = 'cost-router';

  constructor(private readonly o: CostRouterOptions) {
    validatePolicy(o.policy, o.pricing);
  }

  /** The decision for a request, without calling any model. */
  route(request: LLMRequest): Route {
    return decideRoute(this.o.policy, request);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const route = this.route(request);
    const useCache =
      this.o.cache !== undefined && this.o.policy.cache.enabled && request.hints?.cache !== false;

    if (useCache) {
      const started = performance.now();
      const hit = await this.safeCacheGet(hashRequest(request, route.model));
      if (hit) {
        const latencyMs = performance.now() - started;
        await this.record(request, route, hit.response.model, {
          response: hit.response,
          latencyMs,
          cacheHit: true,
          costUsd: 0,
          savedUsd: hit.costUsd ?? 0,
        });
        return { ...hit.response, cached: true, latencyMs };
      }
    }

    const attempts = [
      route.model,
      ...(route.fallback && route.fallback !== route.model ? [route.fallback] : []),
    ];
    let failedModel: string | undefined;
    let lastError: unknown;
    for (const model of attempts) {
      const started = performance.now();
      try {
        const response = await this.callWithTimeout(model, request);
        const costUsd = computeCost(this.o.pricing, response.model, response.usage) ?? null;
        await this.record(request, route, model, {
          response,
          latencyMs: response.latencyMs,
          cacheHit: false,
          costUsd,
          savedUsd: 0,
          fallbackFrom: failedModel,
        });
        if (useCache) {
          await this.safeCacheSet(
            hashRequest(request, route.model),
            { response, costUsd },
            this.o.policy.cache.ttl_seconds,
          );
        }
        return response;
      } catch (err) {
        lastError = err;
        const error = err instanceof LLMError ? err : new LLMError('unknown', String(err));
        await this.record(request, route, model, {
          latencyMs: performance.now() - started,
          cacheHit: false,
          costUsd: null,
          savedUsd: 0,
          error,
          fallbackFrom: failedModel,
        });
        // The caller gave up: not a model failure, and another model would not help.
        if (error.kind === 'aborted') throw error;
        this.o.logger?.warn({ model, kind: error.kind }, 'model call failed');
        failedModel = model;
      }
    }
    throw lastError;
  }

  private callWithTimeout(model: string, request: LLMRequest): Promise<LLMResponse> {
    const provider = this.providerFor(model);
    const timeout = AbortSignal.timeout(this.o.policy.timeout_ms);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    return provider.complete({ ...request, model, signal }).catch((err: unknown) => {
      if (timeout.aborted && !request.signal?.aborted) {
        throw new LLMError(
          'timeout',
          `${model} did not answer within ${this.o.policy.timeout_ms} ms`,
          {
            cause: err,
          },
        );
      }
      throw err;
    });
  }

  private providerFor(model: string): LLMProvider {
    const providerName = priceOf(this.o.pricing, model)?.provider;
    const provider = providerName ? this.o.providers[providerName] : undefined;
    if (!provider) {
      throw new LLMError('invalid_request', `no provider is configured for model "${model}"`);
    }
    return provider;
  }

  private async record(
    request: LLMRequest,
    route: Route,
    model: string,
    r: {
      response?: LLMResponse;
      latencyMs: number;
      cacheHit: boolean;
      costUsd: number | null;
      savedUsd: number;
      fallbackFrom?: string;
      error?: LLMError;
    },
  ): Promise<void> {
    if (!this.o.tracker) return;
    try {
      await this.o.tracker.record({
        ...(request.metadata?.taskId ? { taskId: request.metadata.taskId } : {}),
        ...(request.metadata?.agentId ? { agentId: request.metadata.agentId } : {}),
        model,
        provider: priceOf(this.o.pricing, model)?.provider ?? 'unknown',
        rule: route.rule,
        complexity: route.complexity,
        inputTokens: r.response?.usage.inputTokens ?? 0,
        outputTokens: r.response?.usage.outputTokens ?? 0,
        costUsd: r.costUsd,
        savedUsd: r.savedUsd,
        latencyMs: r.latencyMs,
        simulated: r.response?.simulated ?? priceOf(this.o.pricing, model)?.simulated ?? false,
        cacheHit: r.cacheHit,
        fallbackFrom: r.fallbackFrom,
        status: r.error ? 'error' : 'ok',
        ...(r.error ? { error: `${r.error.kind}: ${r.error.message}` } : {}),
      });
    } catch (err) {
      // Tracking is best effort: it must never fail a model call.
      this.o.logger?.warn({ err: String(err) }, 'failed to record LLM call');
    }
  }

  private async safeCacheGet(key: string): Promise<CacheEntry | undefined> {
    try {
      return await this.o.cache?.get(key);
    } catch (err) {
      this.o.logger?.warn({ err: String(err) }, 'cache read failed; continuing without cache');
      return undefined;
    }
  }

  private async safeCacheSet(key: string, entry: CacheEntry, ttl: number): Promise<void> {
    try {
      await this.o.cache?.set(key, entry, ttl);
    } catch (err) {
      this.o.logger?.warn({ err: String(err) }, 'cache write failed');
    }
  }
}

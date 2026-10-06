import { Counter, Histogram, type Registry } from 'prom-client';
import type { CallTracker, NewCallRecord } from './tracker.js';

/** Prometheus view of the call log. Register it on the API's registry and add it to the tracker. */
export class RouterMetrics implements CallTracker {
  private readonly calls: Counter<'model' | 'outcome'>;
  private readonly tokens: Counter<'model' | 'direction'>;
  private readonly cost: Counter<'model' | 'simulated'>;
  private readonly saved: Counter<'model'>;
  private readonly latency: Histogram<'model' | 'cache'>;

  constructor(registry: Registry) {
    this.calls = new Counter({
      name: 'llm_calls_total',
      help: 'Model calls by model and outcome (ok, error, cache_hit, fallback).',
      labelNames: ['model', 'outcome'],
      registers: [registry],
    });
    this.tokens = new Counter({
      name: 'llm_tokens_total',
      help: 'Tokens by model and direction (input, output).',
      labelNames: ['model', 'direction'],
      registers: [registry],
    });
    this.cost = new Counter({
      name: 'llm_cost_usd_total',
      help: 'Computed cost in USD, from config/pricing.yaml. simulated="true" for the mock provider.',
      labelNames: ['model', 'simulated'],
      registers: [registry],
    });
    this.saved = new Counter({
      name: 'llm_cache_saved_usd_total',
      help: 'Cost avoided thanks to response cache hits, in USD.',
      labelNames: ['model'],
      registers: [registry],
    });
    this.latency = new Histogram({
      name: 'llm_call_latency_seconds',
      help: 'Latency of model calls (simulated for the mock provider).',
      labelNames: ['model', 'cache'],
      buckets: [0.005, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [registry],
    });
  }

  record(call: NewCallRecord): Promise<void> {
    const outcome =
      call.status === 'error'
        ? 'error'
        : call.cacheHit
          ? 'cache_hit'
          : call.fallbackFrom
            ? 'fallback'
            : 'ok';
    this.calls.inc({ model: call.model, outcome });
    this.tokens.inc({ model: call.model, direction: 'input' }, call.inputTokens);
    this.tokens.inc({ model: call.model, direction: 'output' }, call.outputTokens);
    if (call.costUsd !== null)
      this.cost.inc({ model: call.model, simulated: String(call.simulated) }, call.costUsd);
    if (call.savedUsd > 0) this.saved.inc({ model: call.model }, call.savedUsd);
    this.latency.observe(
      { model: call.model, cache: String(call.cacheHit) },
      call.latencyMs / 1000,
    );
    return Promise.resolve();
  }
}

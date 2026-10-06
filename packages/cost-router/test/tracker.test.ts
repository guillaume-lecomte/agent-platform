import { createDb, type DbHandle } from '@agent-platform/core';
import { Registry } from 'prom-client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CompositeTracker,
  InMemoryCallTracker,
  PgCallTracker,
  RouterMetrics,
  migrateRouter,
  percentile,
  summarize,
  type NewCallRecord,
  type QueryableTracker,
} from '../src/index.js';

const call = (over: Partial<NewCallRecord> = {}): NewCallRecord => ({
  model: 'big',
  provider: 'p',
  rule: 'default',
  complexity: 'low',
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.01,
  savedUsd: 0,
  latencyMs: 100,
  simulated: false,
  cacheHit: false,
  status: 'ok',
  ...over,
});

describe('percentile / summarize', () => {
  it('interpolates like percentile_cont', () => {
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(250);
    expect(percentile([100, 200, 300, 400], 0.95)).toBeCloseTo(385);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('aggregates by model with totals, cache hits and unpriced calls', () => {
    const s = summarize(
      [
        call({ latencyMs: 100 }),
        call({ latencyMs: 300, costUsd: 0.03 }),
        call({ model: 'small', costUsd: 0.001, latencyMs: 50 }),
        call({ model: 'small', costUsd: 0, cacheHit: true, savedUsd: 0.001, latencyMs: 1 }),
        call({ model: 'small', costUsd: null, latencyMs: 60 }),
        call({
          model: 'small',
          status: 'error',
          costUsd: null,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 5,
        }),
      ].map((c, i) => ({ ...c, id: String(i), at: '2026-01-01T00:00:00Z' })),
    );
    expect(s.totals).toMatchObject({ calls: 6, cacheHits: 1, costUsd: 0.041, savedUsd: 0.001 });
    const big = s.byModel.find((m) => m.model === 'big');
    expect(big).toMatchObject({ calls: 2, costUsd: 0.04, avgLatencyMs: 200, p50LatencyMs: 200 });
    expect(s.byModel.find((m) => m.model === 'small')).toMatchObject({
      calls: 4,
      errors: 1,
      cacheHits: 1,
      unpricedCalls: 1,
    });
  });
});

const dbUrl = process.env.DATABASE_URL;
let handle: DbHandle | undefined;
afterAll(async () => {
  await handle?.close();
});

const backends: Array<{ name: string; skip?: boolean; make: () => Promise<QueryableTracker> }> = [
  { name: 'in-memory', make: async () => new InMemoryCallTracker() },
  {
    name: 'postgres',
    skip: !dbUrl,
    make: async () => {
      handle ??= createDb(dbUrl!);
      await migrateRouter(handle.db);
      await handle.pool.query('truncate llm_calls');
      return new PgCallTracker(handle.db);
    },
  },
];

describe.each(backends)('QueryableTracker contract: $name', ({ make, skip }) => {
  const it_ = skip ? it.skip : it;

  it_('summarizes what it recorded, the same way for every backend', async () => {
    const t = await make();
    for (const c of [
      call({ latencyMs: 100 }),
      call({ latencyMs: 300, costUsd: 0.03, simulated: true }),
      call({ model: 'small', costUsd: 0.001, latencyMs: 50, taskId: 't1', agentId: 'a' }),
      call({ model: 'small', cacheHit: true, costUsd: 0, savedUsd: 0.001, latencyMs: 1 }),
      call({ model: 'small', status: 'error', costUsd: null, error: 'server: boom', latencyMs: 5 }),
    ]) {
      await t.record(c);
    }
    const s = await t.summary();
    expect(s.simulated).toBe(true);
    expect(s.totals).toMatchObject({ calls: 5, cacheHits: 1, costUsd: 0.041, savedUsd: 0.001 });
    expect(s.byModel.map((m) => m.model)).toEqual(['big', 'small']);
    expect(s.byModel[0]).toMatchObject({ calls: 2, avgLatencyMs: 200, p50LatencyMs: 200 });
    expect(s.byModel[1]).toMatchObject({ calls: 3, errors: 1, cacheHits: 1 });
    const recent = await t.recent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.model).toBe('small');
  });
});

describe('CompositeTracker and RouterMetrics', () => {
  it('keeps going when one tracker fails', async () => {
    const mem = new InMemoryCallTracker();
    const errors: unknown[] = [];
    const t = new CompositeTracker(
      [
        {
          record: async () => {
            throw new Error('nope');
          },
        },
        mem,
      ],
      (e) => errors.push(e),
    );
    await t.record(call());
    expect(mem.records).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('exposes calls, tokens, cost, savings and latency to Prometheus', async () => {
    const registry = new Registry();
    const m = new RouterMetrics(registry);
    await m.record(call({ model: 'big', simulated: true }));
    await m.record(
      call({ model: 'big', cacheHit: true, costUsd: 0, savedUsd: 0.01, latencyMs: 1 }),
    );
    await m.record(call({ model: 'small', status: 'error', costUsd: null }));
    const text = await registry.metrics();
    expect(text).toContain('llm_calls_total{model="big",outcome="ok"} 1');
    expect(text).toContain('llm_calls_total{model="big",outcome="cache_hit"} 1');
    expect(text).toContain('llm_calls_total{model="small",outcome="error"} 1');
    expect(text).toContain('llm_tokens_total{model="big",direction="input"} 2000');
    expect(text).toContain('llm_cost_usd_total{model="big",simulated="true"} 0.01');
    expect(text).toContain('llm_cache_saved_usd_total{model="big"} 0.01');
    expect(text).toContain('llm_call_latency_seconds_count{model="big",cache="false"} 1');
  });
});

import type { Database } from '@agent-platform/core';
import { desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { llmCalls } from './schema.js';

export interface CallRecord {
  id: string;
  at: string;
  taskId?: string;
  agentId?: string;
  model: string;
  provider: string;
  /** Routing rule that chose the model (`default`, `explicit`, or a rule name). */
  rule: string;
  complexity: string;
  inputTokens: number;
  outputTokens: number;
  /** null when the model has no price. */
  costUsd: number | null;
  /** Cost avoided by a cache hit. */
  savedUsd: number;
  latencyMs: number;
  /** Tokens and latency come from a test double, not a measurement. */
  simulated: boolean;
  cacheHit: boolean;
  /** Set on the call that answered after this model failed. */
  fallbackFrom?: string;
  status: 'ok' | 'error';
  error?: string;
}

export type NewCallRecord = Omit<CallRecord, 'id' | 'at'>;

export interface CallTracker {
  record(call: NewCallRecord): Promise<void>;
}

export interface ModelSummary {
  model: string;
  calls: number;
  errors: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of known costs. */
  costUsd: number;
  /** Calls whose cost could not be computed (no price for the model). */
  unpricedCalls: number;
  savedUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** True if any of the calls is simulated. */
  simulated: boolean;
}

export interface CostSummary {
  /** True if any call is simulated: totals must then be read as illustrative. */
  simulated: boolean;
  totals: {
    calls: number;
    cacheHits: number;
    costUsd: number;
    savedUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
  byModel: ModelSummary[];
}

export interface QueryableTracker extends CallTracker {
  summary(): Promise<CostSummary>;
  recent(limit?: number): Promise<CallRecord[]>;
}

/** Linear-interpolated percentile (same definition as PostgreSQL's percentile_cont). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (rank - lo);
}

const round = (n: number, digits = 6): number => Math.round(n * 10 ** digits) / 10 ** digits;

export function summarize(records: CallRecord[]): CostSummary {
  const groups = new Map<string, CallRecord[]>();
  for (const r of records) groups.set(r.model, [...(groups.get(r.model) ?? []), r]);
  const byModel: ModelSummary[] = [...groups]
    .map(([model, list]) => {
      const latencies = list.map((r) => r.latencyMs).sort((a, b) => a - b);
      return {
        model,
        calls: list.length,
        errors: list.filter((r) => r.status === 'error').length,
        cacheHits: list.filter((r) => r.cacheHit).length,
        inputTokens: list.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: list.reduce((n, r) => n + r.outputTokens, 0),
        costUsd: round(list.reduce((n, r) => n + (r.costUsd ?? 0), 0)),
        unpricedCalls: list.filter((r) => r.costUsd === null && r.status === 'ok').length,
        savedUsd: round(list.reduce((n, r) => n + r.savedUsd, 0)),
        avgLatencyMs: round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 2),
        p50LatencyMs: round(percentile(latencies, 0.5), 2),
        p95LatencyMs: round(percentile(latencies, 0.95), 2),
        simulated: list.some((r) => r.simulated),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
  return {
    simulated: records.some((r) => r.simulated),
    totals: {
      calls: records.length,
      cacheHits: records.filter((r) => r.cacheHit).length,
      costUsd: round(byModel.reduce((n, m) => n + m.costUsd, 0)),
      savedUsd: round(byModel.reduce((n, m) => n + m.savedUsd, 0)),
      inputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
      outputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
    },
    byModel,
  };
}

export class InMemoryCallTracker implements QueryableTracker {
  readonly records: CallRecord[] = [];

  record(call: NewCallRecord): Promise<void> {
    this.records.push({ ...call, id: randomUUID(), at: new Date().toISOString() });
    return Promise.resolve();
  }

  summary(): Promise<CostSummary> {
    return Promise.resolve(summarize(this.records));
  }

  recent(limit = 50): Promise<CallRecord[]> {
    return Promise.resolve([...this.records].reverse().slice(0, limit));
  }
}

function toRecord(r: typeof llmCalls.$inferSelect): CallRecord {
  return {
    id: r.id,
    at: new Date(r.at).toISOString(),
    taskId: r.taskId ?? undefined,
    agentId: r.agentId ?? undefined,
    model: r.model,
    provider: r.provider,
    rule: r.rule,
    complexity: r.complexity,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    savedUsd: r.savedUsd,
    latencyMs: r.latencyMs,
    simulated: r.simulated,
    cacheHit: r.cacheHit,
    fallbackFrom: r.fallbackFrom ?? undefined,
    status: r.status as CallRecord['status'],
    error: r.error ?? undefined,
  };
}

/** PostgreSQL call log; aggregation happens in SQL so the dashboard stays cheap. */
export class PgCallTracker implements QueryableTracker {
  constructor(private readonly db: Database) {}

  async record(call: NewCallRecord): Promise<void> {
    await this.db.insert(llmCalls).values({
      taskId: call.taskId ?? null,
      agentId: call.agentId ?? null,
      model: call.model,
      provider: call.provider,
      rule: call.rule,
      complexity: call.complexity,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd,
      savedUsd: call.savedUsd,
      latencyMs: call.latencyMs,
      simulated: call.simulated,
      cacheHit: call.cacheHit,
      fallbackFrom: call.fallbackFrom ?? null,
      status: call.status,
      error: call.error ?? null,
    });
  }

  async summary(): Promise<CostSummary> {
    const rows = await this.db
      .select({
        model: llmCalls.model,
        calls: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${llmCalls.status} = 'error')::int`,
        cacheHits: sql<number>`count(*) filter (where ${llmCalls.cacheHit})::int`,
        inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
        unpricedCalls: sql<number>`count(*) filter (where ${llmCalls.costUsd} is null and ${llmCalls.status} = 'ok')::int`,
        savedUsd: sql<number>`coalesce(sum(${llmCalls.savedUsd}), 0)::float8`,
        avgLatencyMs: sql<number>`avg(${llmCalls.latencyMs})::float8`,
        p50LatencyMs: sql<number>`percentile_cont(0.5) within group (order by ${llmCalls.latencyMs})::float8`,
        p95LatencyMs: sql<number>`percentile_cont(0.95) within group (order by ${llmCalls.latencyMs})::float8`,
        simulated: sql<boolean>`bool_or(${llmCalls.simulated})`,
      })
      .from(llmCalls)
      .groupBy(llmCalls.model);
    const byModel: ModelSummary[] = rows
      .map((r) => ({
        ...r,
        costUsd: round(r.costUsd),
        savedUsd: round(r.savedUsd),
        avgLatencyMs: round(r.avgLatencyMs, 2),
        p50LatencyMs: round(r.p50LatencyMs, 2),
        p95LatencyMs: round(r.p95LatencyMs, 2),
      }))
      .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
    return {
      simulated: byModel.some((m) => m.simulated),
      totals: {
        calls: byModel.reduce((n, m) => n + m.calls, 0),
        cacheHits: byModel.reduce((n, m) => n + m.cacheHits, 0),
        costUsd: round(byModel.reduce((n, m) => n + m.costUsd, 0)),
        savedUsd: round(byModel.reduce((n, m) => n + m.savedUsd, 0)),
        inputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
        outputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
      },
      byModel,
    };
  }

  async recent(limit = 50): Promise<CallRecord[]> {
    const rows = await this.db.select().from(llmCalls).orderBy(desc(llmCalls.at)).limit(limit);
    return rows.map(toRecord);
  }
}

/** Fans a record out to several trackers; a failing one never blocks the others. */
export class CompositeTracker implements CallTracker {
  constructor(
    private readonly trackers: CallTracker[],
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  async record(call: NewCallRecord): Promise<void> {
    await Promise.all(
      this.trackers.map(async (t) => {
        try {
          await t.record(call);
        } catch (err) {
          this.onError(err);
        }
      }),
    );
  }
}

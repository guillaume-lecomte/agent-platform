# @agent-platform/cost-router

An `LLMProvider` that decides which model answers each call. The design is in
[ADR 0009](../../docs/decisions/0009-cost-router-design.md).

- **Policy** (`loadPolicy`, `decideRoute`): a YAML file with a default model, ordered rules matching task
  type and estimated complexity, a fallback per rule, a timeout and cache settings. See
  [`config/routing.yaml`](../../config/routing.yaml).
- **Prices** (`loadPricing`, `computeCost`): [`config/pricing.yaml`](../../config/pricing.yaml). Every model needs a
  source and a date, or loading fails.
- **`CostRouter`**: applies the policy, serves exact repeats from a `ResponseCache` (Redis or in-memory),
  falls back to a second model on error or timeout, and records every attempt in a `CallTracker`.
- **Tracking**: `PgCallTracker` stores one row per attempt and aggregates in SQL; `RouterMetrics` exposes the same
  data to Prometheus.

```ts
const router = new CostRouter({
  providers: { mock: new MockProvider({ responder }) },
  pricing: await loadPricing('config/pricing.yaml'),
  policy: await loadPolicy('config/routing.yaml'),
  cache: new InMemoryResponseCache(),
  tracker: new InMemoryCallTracker(),
});
const answer = await router.complete({ messages, hints: { taskType: 'issue-triage' } });
```

Tests: `pnpm --filter @agent-platform/cost-router test` (set `DATABASE_URL` and `REDIS_URL` to include the
PostgreSQL and Redis ones).

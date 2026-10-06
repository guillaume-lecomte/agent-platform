# 0009: Cost router design

**Status:** accepted (2026-10-06)

## Context

Sending every call to the strongest model is expensive and slow. The router must choose a model
per call, survive provider failures, avoid paying twice for the same call, and make cost visible,
without the rest of the platform knowing any of it.

## Decision

- **The router is an `LLMProvider`.** The runner calls `provider.complete(request)` and does not
  know whether a router, a mock or a vendor SDK answers. The router needs the request to carry
  hints (`taskType`, optional `complexity`, `cache`) and metadata (`taskId`, `agentId`).
- **The policy is data** (`config/routing.yaml`), not code: a default model, ordered rules matching
  task type and estimated complexity, a fallback per rule, a timeout, cache settings. Complexity is
  estimated from the length of the first user message and the number of tools (thresholds in the
  file); a caller-provided `hints.complexity` overrides the estimate. The decision is a pure function
  (`decideRoute`) and is unit-tested without any model.
- **Fallback** to the rule's backup model on any error or timeout, except when the caller aborted
  (another model would not help). Both attempts are recorded. Retries with backoff stay in the
  runner, above the router, so a transient error is first tried on the fallback, then retried.
- **Cache**: exact match on the hash of the normalized request including the model (the same hash
  the mock provider uses for recordings), in Redis with a TTL from the policy, bypassable per request
  (`hints.cache = false`). Failures are not cached, a broken cache never fails a call, and a hit
  returns the original token usage (so the agent's token budget behaves identically) while its
  cost is recorded as zero, with the avoided cost in `saved_usd`. There is no semantic cache.
- **Prices live in `config/pricing.yaml`**, one entry per model with a mandatory source and date;
  loading fails without them. A model without a price yields an _unknown_ cost (`null`), never zero.
  Policies are validated against the price list at startup. OpenAI prices are not included because the
  source could not be read when the file was written; unverified prices are not recorded.
- **Every attempt is a row** in PostgreSQL (`llm_calls`), aggregated in SQL (including p50/p95) for
  the API and dashboard, and mirrored in Prometheus (`llm_calls_total`, `llm_tokens_total`,
  `llm_cost_usd_total`, `llm_call_latency_seconds`, `llm_cache_saved_usd_total`).
- **Mock mode is labelled.** Mock models have illustrative prices and a latency formula, both in the
  pricing file. Every record carries `simulated`, the API returns it, and the benchmark prints it.

## Consequences

- The router adds a single hop and one Redis round trip per call when the cache is enabled.
- Thresholds are workload-specific. The committed ones were read off the mock dataset's length
  distribution and must be re-measured for a real workload; `routing.anthropic.yaml` says so.
- Costs exclude provider features such as prompt caching or batch discounts; the tracker records
  plain input/output token prices only.

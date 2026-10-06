# agent-platform

AI agents fail in production in three predictable ways: a long task dies halfway and restarts from scratch (or repeats a side effect), every call goes to the most expensive model, and a prompt tweak quietly degrades quality. This monorepo shows one way to address each: durable execution, cost-aware routing, and evals that gate CI.

![Demo: a task pauses for approval, the human approves one call and denies another, then reads the step log and the cost view](docs/media/demo.gif)

_The dashboard running against the default mock provider (no API key). Steps: run the agent on an issue, approve `add_labels`, deny `post_comment` with a reason, read the step log, check cost and latency per model (simulated)._

## Architecture

```mermaid
flowchart LR
  client[Dashboard / HTTP client] -- REST + SSE --> api
  subgraph api[apps/api · NestJS]
    svc[TaskService] --> runner[AgentRunner]
    worker[BullMQ worker] --> runner
  end
  svc -- "advance task" --> redis[(Redis · BullMQ, events, cache)]
  redis --> worker
  runner -- "steps, tool registry, approvals" --> pg[(PostgreSQL)]
  runner -- complete --> router[CostRouter: policy, cache, fallback, tracking]
  router --> llm[LLMProvider: mock / Anthropic / OpenAI]
  router -- cache --> redis
  router -- "llm_calls" --> pg
  runner -- execute --> tools[Tools: search, add_labels, post_comment]
```

A job on the queue only means "advance task X". The runner rebuilds the conversation from the
persisted step log, so any worker can continue any task. More detail, the failure table and the data
model: [docs/architecture.md](docs/architecture.md).

## Quick start

Requires Docker. No API key is needed: the default LLM provider is a deterministic mock
([ADR 0003](docs/decisions/0003-explicit-llm-provider.md)).

```bash
git clone <this-repo> agent-platform && cd agent-platform
docker compose up --build
open http://localhost:8080        # or visit it in a browser
```

In the dashboard, click **Run the agent**: the task pauses and asks for approval before adding labels and
before commenting. The API is on `localhost:3000` (`/tasks`, `/approvals`, `/costs`, `/metrics`, `/events`):

```bash
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"input":{"title":"Login button does nothing in Firefox","body":"No effect on click. Version 2.4.1."}}'
curl -s 'localhost:3000/approvals?status=pending'
curl -s -X POST localhost:3000/approvals/<id>/approve -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:3000/approvals/<id>/deny -H 'content-type: application/json' -d '{"reason":"too chatty"}'
```

To work on the code (Node 24, pnpm via corepack):

```bash
corepack enable && pnpm install
docker compose up -d postgres redis
DATABASE_URL=postgres://agent:agent@localhost:5432/agent_platform_test pnpm check
```

## Layout

| Path                       | Purpose                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core`            | LLM and tool interfaces, mock/Anthropic/OpenAI providers, MCP client adapter, config, logger |
| `packages/durable-runner`  | Checkpointed, resumable agent execution on BullMQ + PostgreSQL                               |
| `packages/cost-router`     | Model routing, fallback, response cache, cost and latency tracking                           |
| `packages/evals`, `evals/` | Eval suites, graders, baseline gate, promote/rollback                                        |
| `agents/issue-triage`      | Demo agent: versioned definitions, simulated tools                                           |
| `apps/api`                 | NestJS service: REST, SSE, Prometheus metrics                                                |
| `apps/dashboard`           | React dashboard: tasks, approvals, costs and latency                                         |
| `config/`                  | `pricing.yaml` (with sources and dates), routing policies                                    |
| `scripts/`                 | `crash-demo`, `benchmark-routing`                                                            |

## `packages/core`

**Problem:** every module needs the same few abstractions, and none of them should depend on a
specific vendor SDK.

**Approach:** a small `LLMProvider` interface (completion with tool calls, input/output token
counts, typed errors) with a deterministic `MockProvider`, plus `AnthropicProvider` and
`OpenAIProvider` (Responses API). `Tool` carries a JSON-schema input and a risk level
(`read` | `reversible` | `destructive`). `mcpToolsFromClient` turns the tools of any MCP server
into `Tool`s, ready for the separate `proto-to-mcp` project.

**See it work:** `pnpm --filter @agent-platform/core test`. The MCP adapter is tested against a
minimal in-process MCP server.

The mock provider replays recordings keyed by request hash, falls back to a scripted responder,
and can record real answers when a real provider is supplied. Token counts and latencies it
reports are **simulated** and flagged as such (`simulated: true`).

## `packages/durable-runner`

**Problem:** an agent task lasts minutes, chains model and tool calls, and the process can die
in the middle. Restarting from scratch wastes money; replaying a tool call can post twice.

**Approach:**

- Each model call and tool result is a checkpoint in PostgreSQL. After a crash the next worker
  continues from the last one and does not replay finished steps.
- A registry of tool calls (key: task + step + hash of arguments) guarantees that a tool with an
  effect is never executed twice. If the outcome of an interrupted call is unknown, the agent is
  told so instead of the call being repeated.
- `reversible` and `destructive` tools pause the task (`awaiting_approval`) until a human
  approves or denies through the API. A denial, with its reason, is returned to the agent as the
  tool result.
- Transient provider errors are retried with exponential backoff; other errors fail the task.
- A token budget stops the task cleanly as `budget_exceeded`; tasks can be cancelled.
- Lifecycle events are published on Redis and streamed to clients on `GET /events` (SSE).

Guarantees and mechanisms: [ADR 0005](docs/decisions/0005-durable-execution-semantics.md).

**See it work:** start PostgreSQL and Redis, then run the crash demo. It starts a worker, lets the
agent apply a label, kills the worker with `SIGKILL`, starts another one, and verifies the result in
the database.

```bash
docker compose up -d postgres redis
pnpm crash-demo
```

Output of the run on 2026-10-06 (abridged; timings vary):

```text
+  6.2s  human: approving add_labels (reversible) {"labels":["bug","priority:P0"],"issue_number":4242}
+  6.3s  add_labels has been applied once; task has 4 checkpointed steps
+  6.3s  💥 SIGKILL worker A (no chance to clean up)
+ 12.1s     [worker B pid 85732] job stalled (worker lost its lock); it will be re-queued
+ 12.1s     event task.resumed
+ 13.4s  human: approving post_comment (destructive) ...
+ 14.4s     event task.completed
+ 14.5s  ✔ steps are contiguous and none was duplicated (7 steps)
+ 14.5s  ✔ add_labels executed exactly once (1 execution(s))
+ 14.5s  ✔ post_comment executed exactly once (1 execution(s))
PASS: resumed from the checkpoint, no step replayed, no effect repeated.
```

The ~5 s gap is configured in the demo (lock 3 s, stalled check 1 s); BullMQ's defaults are 30 s
each. The simulated "GitHub" records every effect in a table without a uniqueness constraint,
so a double execution would be visible there. CI runs the demo on every pull request.

Unit tests cover the loop itself (resume, idempotency, retries, budget, cancellation, races);
the same store contract is run against an in-memory implementation and PostgreSQL.

## `packages/cost-router`

**Problem:** calling the strongest model for everything is expensive and slow.

**Approach:**

- A declarative policy ([`config/routing.yaml`](config/routing.yaml)) picks the model per call from the
  task type and an estimated complexity (input length, number of tools, or a hint from the caller),
  with a default model and a fallback per rule.
- On an error or a timeout the call falls back to the backup model; both attempts are recorded.
- Exact repeats are served from a Redis cache (TTL in the policy, bypassable per request).
- Every attempt is stored in PostgreSQL with model, tokens, cost, latency and cache hit/miss, exposed
  as Prometheus metrics (`llm_*`) and at `GET /costs`. Prices come from
  [`config/pricing.yaml`](config/pricing.yaml), where each model has a source and a date.
  Design notes: [ADR 0009](docs/decisions/0009-cost-router-design.md).

**See it work:** run a few tasks, then open the dashboard's "Costs & latency" view or
`curl -s localhost:3000/costs`. The comparison is in [Benchmark results](#benchmark-results).

## `packages/evals` and `evals/`

**Problem:** a prompt or model change can degrade the agent and nobody notices.

**Approach:**

- A suite (`evals/issue-triage/suite.yaml`) holds 40 synthetic issues for a fictional project
  (no personal data): 14 bugs, 9 features, 8 questions, 9 duplicates of known issues. Each case has
  weighted graders: exact match, regex, JSON-schema validation, presence or absence of a tool call,
  and an optional LLM judge (skipped in mock mode). Format: [packages/evals/README.md](packages/evals/README.md).
- A baseline (`baseline.json`) is committed. A run fails if the overall score, **or any category**,
  drops beyond a threshold (3 points overall, 8 per category by default). Why these rules:
  [ADR 0008](docs/decisions/0008-eval-gate-and-baseline.md).
- `pnpm agent promote` moves `active.json` only if the evals pass; `pnpm agent rollback` goes back
  one deployment, with history.
- In CI, every pull request runs the gate on the deployed version, only when the agent, the eval
  tooling or the suite is affected (Turborepo), and a bot comment shows the summary and the gap to
  the baseline. A manual workflow runs the same suite against a real provider if its secret exists.

**See it work** (mock mode, so deterministic; run on 2026-10-06):

```bash
pnpm evals run --agent issue-triage --version v1   # the baseline: passes
pnpm evals run --agent issue-triage --version v2   # exit code 1
pnpm agent promote issue-triage v2                 # refused, active.json untouched
pnpm agent promote issue-triage v3                 # evals pass, v3 becomes active
pnpm agent rollback issue-triage                   # back to v1; see `pnpm agent status issue-triage`
```

| Version | Overall score | Cases fully passed | Gate                 |
| ------- | ------------: | -----------------: | -------------------- |
| v1      |         96.9% |              38/40 | baseline             |
| v2      |         54.7% |               0/40 | ❌ blocked (-42 pts) |
| v3      |         96.9% |              38/40 | ✅ promoted          |

`v2` is the "faster, cheaper" prompt: it drops the duplicate search, the priority rubric and the
follow-up question. Per category, duplicates fall from 100 % to 20 %, which the overall average
alone would understate. `v3` is a harmless rewording of `v1`. `active.json` records the demonstration
above (initial, promote v3, rollback to v1).

> **These scores come from a scripted stand-in for the model, not from a real LLM**
> ([ADR 0007](docs/decisions/0007-mock-model-is-a-test-double.md)). They demonstrate the pipeline,
> not the quality of any prompt or model. Use the "Evals with a real provider" workflow for that.

## `agents/issue-triage`

A neutral demo agent. It receives a GitHub issue, classifies it (bug, feature, question,
duplicate), estimates a priority, proposes labels and drafts a reply. Tools are simulated
locally: `search_similar_issues` (read), `add_labels` (reversible), `post_comment` (destructive).
The deployed version is named in `agents/issue-triage/active.json`.

In mock mode a scripted responder stands in for the model. It reads the prompt for specific
instructions and behaves as a model following them would, so changing the prompt changes the
behaviour. See [`responder.ts`](agents/issue-triage/src/responder.ts).

## Benchmark results

2026-10-06, `pnpm benchmark`, mock provider, 40 cases of the issue-triage suite, agent
`issue-triage@v1`, run sequentially. The full output with its configuration is in
[docs/benchmark-routing.md](docs/benchmark-routing.md); CI regenerates it and fails if it differs, so these
numbers are reproducible.

| Strategy                               | Eval score | Cost (simulated) | Avg latency / task (simulated) | Calls per model                 |
| -------------------------------------- | ---------: | ---------------: | -----------------------------: | ------------------------------- |
| always large                           |      96.9% |           $0.497 |                         5.88 s | mock-large ×160                 |
| always small                           |      95.3% |          $0.0412 |                         1.45 s | mock-small ×160                 |
| routing                                |      96.5% |           $0.182 |                         2.79 s | mock-large ×48, mock-small ×112 |
| routing, 2nd run (warm cache, 160 hit) |      96.5% |          $0.0000 |                         0.00 s | cached                          |

> **Everything in this table is simulated.** Prices are illustrative (a "large" model about 12×
> a "small" one), latencies come from a formula in the pricing file, and scores come from a
> scripted model whose "small" version simply reads less of the issue
> ([ADR 0007](docs/decisions/0007-mock-model-is-a-test-double.md)). The table shows that the
> mechanism routes short inputs to the small model and keeps quality close to the large one, not
> what it would save with real models. The length thresholds were read off this dataset, so the
> routing row is tuned to it. To measure real models:
> `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=… ROUTER_POLICY=routing.anthropic.yaml pnpm benchmark --large claude-sonnet-5-5 --small claude-haiku-4-5-20251001`.

## Observability

Structured JSON logs (pino), Prometheus metrics at `GET /metrics`, and optional OpenTelemetry traces:
set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector. Details in [docs/architecture.md](docs/architecture.md#observability).

## Known limits of the POC

- No authentication; the API and the dashboard are open and CORS is permissive. Run it on your machine.
- Single Redis and PostgreSQL instance, no high availability, no Kubernetes manifests.
- A crashed worker's task resumes after BullMQ's lock timeout, not instantly.
- A model call interrupted by a crash is paid again on resume. Tool calls within one model turn run sequentially.
- Mock-mode eval scores and benchmark numbers come from a test double; they validate the pipeline, not a model.
- Cost accounting uses plain input/output prices (no provider prompt-cache or batch discounts); the response
  cache is exact-match only. OpenAI prices are not in `config/pricing.yaml` (source unreadable when written).
- The agent registry is static ([ADR 0006](docs/decisions/0006-static-agent-registry.md)).

## Decisions

Architecture decision records: [docs/decisions](docs/decisions/README.md).

## Roadmap

See [ROADMAP.md](ROADMAP.md): `apps/incident-copilot`, `proto-to-mcp` integration, and what was deferred.

## License

[MIT](LICENSE)

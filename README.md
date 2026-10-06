# agent-platform

A reference TypeScript monorepo for running LLM agents in production without the usual surprises: tasks that survive a crash, model calls that don't all go to the most expensive model, and a CI that fails when a prompt change makes the agent worse.

It ships one small demo agent (it triages GitHub issues) so you can watch all three at work. Everything runs locally against a built-in mock model, with no API key and no account.

![A task pauses for approval, the human approves one call and denies another, then reads the step log and the cost view](docs/media/demo.gif)

_The dashboard on the default mock provider: run the agent on an issue, approve `add_labels`, deny `post_comment` with a reason, read the step log, check cost and latency per model (simulated)._

## The problems this addresses

### 1. A long-running agent dies halfway

An agent task is a loop: call the model, run a tool, call the model again. It can take minutes and it touches the outside world. If the process is killed after the agent has posted a comment, the obvious recovery (run the task again) posts the comment a second time and pays for every model call again.

What this repo does: every model call and tool result is saved as a step in PostgreSQL, so another worker continues from the last step instead of restarting. Tools that change something (add a label, post a comment) are recorded before they run and wait for a human approval, so they run at most once. `pnpm crash-demo` kills a worker with `SIGKILL` mid-task and checks all of this in the database. Details: [packages/durable-runner](packages/durable-runner), [ADR 0005](docs/decisions/0005-durable-execution-semantics.md).

### 2. Every call goes to the biggest model

Classifying a one-line typo report does not need the same model as untangling a long incident write-up, but a hard-coded model name sends both to the same place. You pay more, wait longer, and have no idea where the money went.

What this repo does: a routing policy in YAML picks the model per call from the task type and an estimate of its complexity, falls back to a second model on error or timeout, and serves exact repeats from a Redis cache. Every call is recorded with its tokens, cost and latency, shown in the dashboard and in Prometheus. Prices live in [config/pricing.yaml](config/pricing.yaml), each with a source and a date. Details: [packages/cost-router](packages/cost-router), [ADR 0009](docs/decisions/0009-cost-router-design.md).

### 3. A prompt change quietly makes the agent worse

Someone shortens a prompt to save tokens. Unit tests pass, the agent still answers, and nobody notices that it no longer detects duplicate issues until users complain.

What this repo does: a suite of 40 cases is scored on every run and compared with a committed baseline. CI fails if the overall score, or the score of any single category, drops beyond a threshold. `pnpm agent promote` only deploys a new agent version if it passes, and `pnpm agent rollback` goes back. The repo includes a deliberately degraded prompt (`v2`) that the gate blocks. Details: [packages/evals](packages/evals), [ADR 0008](docs/decisions/0008-eval-gate-and-baseline.md).

## Requirements

To run the demo you only need Docker:

| Requirement                       | Notes                                                                  |
| --------------------------------- | ---------------------------------------------------------------------- |
| Docker with Compose v2            | `docker compose version` should work. Docker Desktop or Docker Engine. |
| Free ports                        | 3000 (API), 8080 (dashboard), 5432 (PostgreSQL), 6379 (Redis)          |
| About 2 GB of disk, a few minutes | For the images and the first build                                     |
| A browser                         | For the dashboard                                                      |

No API key, no account, no network access after the images are built.

To work on the code you also need Node 24 (`.nvmrc`; 22 works) and pnpm 12, which `corepack enable` provides. PostgreSQL and Redis come from `docker compose up -d postgres redis`.

## Quickstart

```bash
git clone <this-repo> agent-platform && cd agent-platform
docker compose up --build
```

The first build takes a few minutes. When the log shows `api listening`, open <http://localhost:8080>.

1. On the Tasks page, click **Run the agent** (a sample issue is pre-filled).
2. The task moves to "Needs approval" and the Approvals tab shows a badge. Open it: the agent wants to call `add_labels`. Approve it.
3. A second request appears for `post_comment`. Approve it, or deny it with a reason and watch the agent adapt.
4. Back on Tasks, click the task to read its step log and the agent's answer. "Costs & latency" shows what the model calls cost (simulated, see below).

To stop: `Ctrl+C`, then `docker compose down` (add `-v` to delete the data).

If something does not work:

| Symptom                               | Likely cause and fix                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon` | Start Docker Desktop (or the daemon) and retry.                                                                        |
| `port is already allocated`           | Something uses 3000, 8080, 5432 or 6379. Stop it, or change the left side of the port mapping in `docker-compose.yml`. |
| The dashboard shows an error or a 502 | The API is still starting. Wait for `api listening` in `docker compose logs api` and reload.                           |
| Nothing happens after "Run the agent" | Check `docker compose logs api` for errors; `curl localhost:3000/health` should answer `ok`.                           |

### The other demos

Each of these runs locally and prints what it proves. The first needs PostgreSQL and Redis running (`docker compose up -d postgres redis`).

```bash
pnpm install                                        # once; needs Node and corepack
pnpm crash-demo                                     # kill a worker mid-task, check the resume
pnpm evals run --agent issue-triage --version v2    # a degraded prompt, blocked by the gate (exit code 1)
pnpm agent promote issue-triage v2                  # refused; v3 would be accepted
pnpm benchmark                                      # large vs small vs routed, cost and latency
```

The HTTP API is described in [docs/api.md](docs/api.md).

## How it fits together

```mermaid
flowchart LR
  client[Dashboard / HTTP client] -- REST + SSE --> api
  subgraph api[apps/api · NestJS]
    svc[TaskService] --> runner[AgentRunner]
    worker[BullMQ worker] --> runner
  end
  svc -- "advance task" --> redis[(Redis · queue, events, cache)]
  redis --> worker
  runner -- "steps, tool registry, approvals" --> pg[(PostgreSQL)]
  runner -- complete --> router[CostRouter]
  router --> llm[LLM provider: mock / Anthropic / OpenAI]
  router -- cache --> redis
  router -- "llm_calls" --> pg
  runner -- execute --> tools[Tools: search, add_labels, post_comment]
```

A job on the queue only means "advance task X". The runner rebuilds the conversation from the saved
steps, so any worker can continue any task. The full picture, the data model and a table of what
happens on each kind of failure are in [docs/architecture.md](docs/architecture.md).

| Path                       | What it is                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/core`            | Provider and tool interfaces, mock/Anthropic/OpenAI providers, MCP client adapter, config, logger |
| `packages/durable-runner`  | Resumable agent execution on BullMQ and PostgreSQL                                                |
| `packages/cost-router`     | Model routing, fallback, response cache, cost and latency tracking                                |
| `packages/evals`, `evals/` | Eval suites, graders, baseline gate, promote and rollback                                         |
| `agents/issue-triage`      | The demo agent: versioned prompts, simulated tools                                                |
| `apps/api`                 | NestJS service: REST, SSE, Prometheus metrics                                                     |
| `apps/dashboard`           | React dashboard: tasks, approvals, costs                                                          |
| `config/`                  | Price list and routing policies                                                                   |
| `scripts/`                 | Crash demo and routing benchmark                                                                  |

## The modules

### core

A small `LLMProvider` interface (completion with tool calls, token counts in and out, typed errors)
with a deterministic `MockProvider`, an `AnthropicProvider` and an `OpenAIProvider` (Responses API).
A `Tool` has a JSON-schema input and a risk level: `read`, `reversible` or `destructive`. Anything
other than `read` needs a human approval. `mcpToolsFromClient` turns the tools of an MCP server into
`Tool`s; it is tested against a minimal in-process server, and is meant for the separate `proto-to-mcp` project.

The mock provider replays recordings keyed by request hash, falls back to a scripted responder, and
can record real answers when it is given a real provider. Its token counts and latencies are
estimates and are flagged `simulated`.

### durable-runner

The loop, the guarantees and the mechanisms are in [ADR 0005](docs/decisions/0005-durable-execution-semantics.md). In short:
steps are saved in PostgreSQL after every model call and tool call; a registry keyed by task, step and
argument hash makes tools with an effect run at most once (and tells the agent when the outcome of an
interrupted call is unknown rather than guessing); approvals pause the task; transient provider errors
are retried with exponential backoff; a token budget stops the task cleanly; tasks can be cancelled;
lifecycle events go to Redis and are streamed to the dashboard over SSE.

`pnpm crash-demo` output (2026-10-06, abridged, timings vary):

```text
+  6.3s  add_labels has been applied once; task has 4 checkpointed steps
+  6.3s  SIGKILL worker A (no chance to clean up)
+ 12.1s     [worker B pid 85732] job stalled (worker lost its lock); it will be re-queued
+ 12.1s     event task.resumed
+ 14.4s     event task.completed
+ 14.5s  ok    steps are contiguous and none was duplicated (7 steps)
+ 14.5s  ok    add_labels executed exactly once (1 execution(s))
+ 14.5s  ok    post_comment executed exactly once (1 execution(s))
PASS: resumed from the checkpoint, no step replayed, no effect repeated.
```

The five-second gap is set by the demo (lock 3 s, stalled check 1 s); BullMQ's defaults are 30 s each. The
simulated "GitHub" logs every effect in a table with no uniqueness constraint, so a double execution would
show up there. CI runs the demo on every pull request.

### cost-router

The routing policy, the cache and the cost tracking are described in [ADR 0009](docs/decisions/0009-cost-router-design.md). The
policy ([`config/routing.yaml`](config/routing.yaml)) matches a task type and an estimated complexity
(input length, number of tools, or a hint from the caller), and names a model and a fallback. The cost
of each call is tokens times the price in [`config/pricing.yaml`](config/pricing.yaml); a model with no
price has an unknown cost, never a zero one.

### evals

A suite is a YAML file of cases, each with weighted graders (exact match, regex, JSON schema, tool called
or not called, optional LLM judge). The 40 cases of `evals/issue-triage/suite.yaml` are synthetic issues for
a fictional project: 14 bugs, 9 features, 8 questions and 9 duplicates of known issues. The format is
described in [packages/evals/README.md](packages/evals/README.md). In CI, pull requests run the gate on the
deployed version, only when the agent, the eval tooling or the suite changed (Turborepo), and a bot comment
shows the gap to the baseline. A manual workflow runs the same suite against a real provider if its secret is set.

### The demo agent

`agents/issue-triage` receives an issue, classifies it (bug, feature, question, duplicate), estimates a
priority, proposes labels and drafts a reply. Its tools are simulated locally: `search_similar_issues`
(read), `add_labels` (reversible), `post_comment` (destructive). `active.json` names the deployed
version: `v1` is the reference prompt, `v2` the degraded one, `v3` a harmless rewording of `v1`.

## Results

Read this first: with the default mock provider, the "model" is a script that follows the instructions it
finds in the prompt ([ADR 0007](docs/decisions/0007-mock-model-is-a-test-double.md)). The scores, token counts and
latencies below come from that script, and the prices are illustrative. They show that the pipeline works, not how good
any real prompt or model is. To measure a real model, use the manual "Evals with a real provider" workflow, or the
real-provider command at the end of this section.

### Eval gate

2026-10-06, mock mode, `pnpm evals run --agent issue-triage --version <v>`.

| Version | Overall score | Cases fully passed | Gate                    |
| ------- | ------------: | -----------------: | ----------------------- |
| v1      |         96.9% |              38/40 | baseline                |
| v2      |         54.7% |               0/40 | blocked (-42 points)    |
| v3      |         96.9% |              38/40 | passes, can be promoted |

`v2` drops the duplicate search, the priority rubric and the follow-up questions. Per category, duplicates fall
from 100% to 20%, which the overall average understates. `active.json` records one promotion (v3) and one rollback to v1.

### Routing

2026-10-06, mock mode, `pnpm benchmark`, 40 cases, agent `issue-triage@v1`. The full output with its configuration is in
[docs/benchmark-routing.md](docs/benchmark-routing.md); CI regenerates it and fails if it differs.

| Strategy                                | Eval score | Cost (simulated) | Avg latency per task (simulated) | Calls per model                 |
| --------------------------------------- | ---------: | ---------------: | -------------------------------: | ------------------------------- |
| always large                            |      96.9% |           $0.497 |                           5.88 s | mock-large x160                 |
| always small                            |      95.3% |          $0.0412 |                           1.45 s | mock-small x160                 |
| routing                                 |      96.5% |           $0.182 |                           2.79 s | mock-large x48, mock-small x112 |
| routing, 2nd run (warm cache, 160 hits) |      96.5% |          $0.0000 |                           0.00 s | cached                          |

The "small" mock model reads only the start of an issue, and the length thresholds in the policy were chosen
from the length distribution of this dataset, so the routing row is tuned to it. With real models:

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... ROUTER_POLICY=routing.anthropic.yaml \
  pnpm benchmark --large claude-sonnet-5-5 --small claude-haiku-4-5-20251001
```

## Development

```bash
corepack enable && pnpm install
docker compose up -d postgres redis
DATABASE_URL=postgres://agent:agent@localhost:5432/agent_platform_test REDIS_URL=redis://localhost:6379 pnpm check
```

`pnpm check` runs formatting, lint, typecheck and all tests. Tests that need PostgreSQL or Redis are skipped when
`DATABASE_URL` or `REDIS_URL` is not set; use the `_test` database so they do not touch the demo's data.
`pnpm evals baseline ...` rewrites the committed baseline and should be a deliberate, reviewed change.
Configuration is validated at startup; every variable is listed in [`.env.example`](.env.example).

Observability: JSON logs (pino), Prometheus metrics at `GET /metrics`, and optional OpenTelemetry traces
(set `OTEL_EXPORTER_OTLP_ENDPOINT`).

## Known limits

- No authentication. The API and the dashboard are open and CORS is permissive: run it on your own machine.
- One Redis and one PostgreSQL instance, no high availability, no Kubernetes manifests.
- A crashed worker's task resumes after BullMQ's lock timeout, not instantly, and a model call interrupted by a crash is paid again.
- Tool calls requested in the same model turn run one after the other.
- Costs use plain input and output prices (no provider prompt-cache or batch discounts), and the cache is exact-match only.
  There are no OpenAI prices in `config/pricing.yaml`: the source could not be read when it was written.
- Agents are registered statically ([ADR 0006](docs/decisions/0006-static-agent-registry.md)).

More decisions are recorded in [docs/decisions](docs/decisions/README.md). What was left out is in [ROADMAP.md](ROADMAP.md).
To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md); to report a security issue, [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

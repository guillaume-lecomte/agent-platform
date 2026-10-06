# agent-platform

AI agents fail in production in three predictable ways: a long task dies halfway and restarts from scratch (or repeats a side effect), every call goes to the most expensive model, and a prompt tweak quietly degrades quality. This monorepo shows one way to address each: durable execution, cost-aware routing, and evals that gate CI.

> **Status: v0.3.0.** Durable execution and the eval gate are done and demonstrable. The cost router and the dashboard land in the next milestones (table below). Nothing in this README claims a result that the repository cannot reproduce.

## Architecture

```mermaid
flowchart LR
  client[Client / dashboard] -- REST + SSE --> api
  subgraph api[apps/api · NestJS]
    svc[TaskService] --> runner[AgentRunner]
    worker[BullMQ worker] --> runner
  end
  svc -- "advance task" --> redis[(Redis · BullMQ + events)]
  redis --> worker
  runner -- "steps, tool registry, approvals" --> pg[(PostgreSQL)]
  runner -- complete --> llm[LLMProvider: mock / Anthropic / OpenAI]
  runner -- execute --> tools[Tools: search, add_labels, post_comment]
```

A job on the queue only means "advance task X". The runner rebuilds the conversation from the
persisted step log, so any worker can continue any task. Details and guarantees:
[ADR 0005](docs/decisions/0005-durable-execution-semantics.md).

## Quick start

Requires Docker. No API key is needed: the default LLM provider is a deterministic mock
([ADR 0003](docs/decisions/0003-explicit-llm-provider.md)).

```bash
git clone <this-repo> agent-platform && cd agent-platform
docker compose up --build -d
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"input":{"title":"Login button does nothing in Firefox","body":"No effect on click. Version 2.4.1."}}'
```

The agent searches for similar issues, then asks for approval before labeling and before commenting:

```bash
curl -s 'localhost:3000/approvals?status=pending'                       # what is waiting for a human
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

| Path                       | Purpose                                                                                      | Status         |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------- |
| `packages/core`            | LLM and tool interfaces, mock/Anthropic/OpenAI providers, MCP client adapter, config, logger | v0.1.0         |
| `packages/durable-runner`  | Checkpointed, resumable agent execution on BullMQ + PostgreSQL                               | v0.2.0         |
| `agents/issue-triage`      | Demo agent: versioned definitions, simulated tools                                           | v0.2.0         |
| `apps/api`                 | NestJS service: REST, SSE, Prometheus metrics                                                | v0.2.0         |
| `scripts`                  | `crash-demo`                                                                                 | v0.2.0         |
| `packages/evals`, `evals/` | Eval suites, baseline, CI gate, promote/rollback                                             | planned v0.3.0 |
| `packages/cost-router`     | Model routing, fallback, cache, cost tracking                                                | planned v0.4.0 |
| `apps/dashboard`           | Tasks, approvals, costs                                                                      | planned v0.5.0 |

## `packages/core`

**Problem:** every module needs the same few abstractions, and none of them should depend on a
specific vendor SDK.

**Approach:** a small `LLMProvider` interface (completion with tool calls, input/output token
counts, typed errors) with a deterministic `MockProvider`, plus `AnthropicProvider` and
`OpenAIProvider` (Responses API). `Tool` carries a JSON-schema input and a risk level
(`read` | `reversible` | `destructive`). `mcpToolsFromClient` turns the tools of any MCP server
into `Tool`s.

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
so a double execution would be visible there.

Unit tests cover the loop itself (resume, idempotency, retries, budget, cancellation, races);
the same store contract is run against an in-memory implementation and PostgreSQL.

## `agents/issue-triage`

A neutral demo agent. It receives a GitHub issue, classifies it (bug, feature, question,
duplicate), estimates a priority, proposes labels and drafts a reply. Tools are simulated
locally: `search_similar_issues` (read), `add_labels` (reversible), `post_comment` (destructive).
The deployed version is named in `agents/issue-triage/active.json`; `v1.yaml` is the reference
prompt, `v2.yaml` a shorter prompt that is deliberately worse (it is what the evals must catch),
and `v3.yaml` a harmless rewording of `v1` used to demonstrate a successful promotion.

In mock mode a scripted responder stands in for the model. It reads the prompt for specific
instructions and behaves as a model following them would, so changing the prompt changes the
behaviour. This is a test double, **not a measurement of any model**; see
[`responder.ts`](agents/issue-triage/src/responder.ts).

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
alone would understate.

> **These scores come from a scripted stand-in for the model, not from a real LLM**
> ([ADR 0007](docs/decisions/0007-mock-model-is-a-test-double.md)). They demonstrate the pipeline,
> not the quality of any prompt or model. Use the "Evals with a real provider" workflow for that.

`active.json` records the demonstration above (initial, promote v3, rollback to v1).

## Decisions

Architecture decision records live in [docs/decisions](docs/decisions/README.md).

## Known limits of the POC

- No authentication; the API is open and CORS is permissive (intentional, documented).
- Single Redis and PostgreSQL instance, no high availability, no Kubernetes manifests.
- A crashed worker's task resumes after BullMQ's lock timeout, not instantly.
- A model call interrupted by a crash is paid again on resume.
- Mock-mode eval scores are produced by a test double; they validate the pipeline, not a model.
- Tool calls within one model turn run sequentially.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)

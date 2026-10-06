# agent-platform

AI agents fail in production in three predictable ways: a long task dies halfway and restarts from scratch (or repeats a side effect), every call goes to the most expensive model, and a prompt tweak quietly degrades quality. This monorepo shows one way to address each: durable execution, cost-aware routing, and evals that gate CI.

> **Status: v0.1.0 (foundation).** The runner, router, evals and dashboard land in the following milestones; see [ROADMAP.md](ROADMAP.md) and the table below. Nothing in this README claims a result that the repository cannot reproduce.

## Quick start

Requires Docker, and Node 24 + pnpm only if you want to run tests.

```bash
git clone <this-repo> agent-platform && cd agent-platform
docker compose up --build
curl localhost:3000/health
```

No API key is needed: the default LLM provider is a deterministic mock (see
[ADR 0003](docs/decisions/0003-explicit-llm-provider.md)).

To work on the code:

```bash
corepack enable && pnpm install
pnpm check        # format, lint, typecheck, tests (tests need `docker compose up -d postgres redis`)
```

## Layout

| Path                       | Purpose                                                                                      | Status         |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------- |
| `packages/core`            | LLM and tool interfaces, mock/Anthropic/OpenAI providers, MCP client adapter, config, logger | v0.1.0         |
| `apps/api`                 | NestJS service (health endpoint so far)                                                      | v0.1.0         |
| `packages/durable-runner`  | Checkpointed, resumable agent execution                                                      | planned v0.2.0 |
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

## Decisions

Architecture decision records live in [docs/decisions](docs/decisions/README.md).

## Known limits of the POC

- No authentication; the API is open (documented, intentional).
- Single Redis and PostgreSQL instance, no high availability, no Kubernetes manifests.

## License

[MIT](LICENSE)

# Roadmap

## Delivered

| Tag    | Milestone                                                                                   |
| ------ | ------------------------------------------------------------------------------------------- |
| v0.1.0 | Monorepo, `core` with the mock provider, `docker compose` for Redis, PostgreSQL and the API |
| v0.2.0 | Durable runner: checkpoints, tool registry, human approval, crash demo                      |
| v0.3.0 | Evals: suites, baseline gate in CI, promote and rollback                                    |
| v0.4.0 | Cost router: policy routing, fallback, cache, cost tracking, benchmark                      |
| v0.5.0 | Dashboard, architecture docs, optional OpenTelemetry                                        |

## Next

- `apps/incident-copilot`: a second reference agent (incident triage) reusing the runner, the router and the
  eval tooling. Not started.
- `proto-to-mcp` integration: the MCP client adapter in `@agent-platform/core` can already consume the tools
  that separate project generates.

## Deliberately left out

Each of these would cost more complexity than it would add to the demonstration.

- Authentication and multi-tenancy. The API and the dashboard are open; this is a documented limit.
- Kubernetes manifests, high availability for Redis or PostgreSQL.
- A semantic (embedding-based) response cache. Only exact-match caching is implemented.
- Provider prompt-cache and batch pricing in the cost model. Only plain input and output prices are used.
- OpenAI prices in `config/pricing.yaml`: the source could not be read when the file was written (ADR 0009).
- Routing driven by observed quality (thresholds learned from eval results) instead of hand-set thresholds.
- Fetching prices automatically; `config/pricing.yaml` is maintained by hand.

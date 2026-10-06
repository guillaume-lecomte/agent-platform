# Roadmap

Delivered milestones are listed in [README.md](README.md). Items below were deliberately left
out of the POC or deferred; each one would strengthen the demonstration less than it would
cost in complexity.

## Planned

- `apps/incident-copilot`: a second reference agent (incident triage) reusing the runner,
  the router and the eval tooling. Directory reserved, not started.
- `proto-to-mcp` integration: the MCP client adapter in `@agent-platform/core` is ready to
  consume tools from that (separate) project.

## Deferred

- Authentication and multi-tenancy (the API and dashboard are open; documented limit).
- Kubernetes manifests, high availability of Redis or PostgreSQL.
- Semantic (embedding-based) response cache; only exact-match caching is implemented.
- Provider prompt-cache and batch pricing in the cost model; only plain input/output prices are used.
- OpenAI entries in `config/pricing.yaml` (the price source could not be read; see ADR 0009).
- Routing on observed quality (learning thresholds from eval results) instead of hand-set thresholds.
- Pricing is read from `config/pricing.yaml`, which is maintained by hand. Fetching prices
  automatically is out of scope.

# Contributing

This is a proof of concept, but changes are welcome. A few conventions keep it coherent.

## Setup

```bash
corepack enable && pnpm install
docker compose up -d postgres redis
export DATABASE_URL=postgres://agent:agent@localhost:5432/agent_platform_test REDIS_URL=redis://localhost:6379
pnpm check            # format, lint, typecheck, tests
```

Useful while working: `pnpm --filter <package> test`, `pnpm crash-demo`, `pnpm evals run --agent issue-triage --version active`,
`pnpm benchmark`.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(cost-router): ...`, `fix(api): ...`).
- **Decisions** that a reader could reasonably disagree with get a short ADR in `docs/decisions/`.
- **Numbers** in the README must come from a script in the repository, with the date and the command. If you change
  the agent, the router or the dataset, rerun `pnpm benchmark --out docs/benchmark-routing.md` (CI checks it).
- **The eval baseline** (`evals/<agent>/baseline.json`) only changes through `pnpm evals baseline`, in its own commit,
  with the reason in the message. Lowering the bar should be a visible, reviewed decision.
- **Prices** in `config/pricing.yaml` need a source and the date they were read.
- **No secrets** in the repository. `scripts/check-secrets.sh` runs in CI.

## Adding an agent

Create `agents/<id>` (definitions `v1.yaml`, `active.json`, tools, optionally a mock responder), register it in
`apps/api/src/agents.ts` and `packages/evals/src/agents.ts`, and add a suite under `evals/<id>`. See
[ADR 0006](docs/decisions/0006-static-agent-registry.md).

# 0006: Agents are registered statically

**Status:** accepted (2026-10-06)

## Context

An agent is a versioned YAML definition (prompt, routing, tools, budget) plus code (its tools and,
in mock mode, its scripted behaviour). Something must map an agent id and version to both.

## Decision

Each agent is a workspace package (`agents/<id>`) exporting `resolve<Agent>(version)`; the API and
the eval CLI list the agents they host explicitly (`apps/api/src/agents.ts`,
`packages/evals/src/agents.ts`). No plugin discovery, no dynamic `import()` by convention.

## Consequences

- Adding an agent touches two small files. Dependencies are explicit and typed.
- Hosting agents from outside the repository is not supported. That is outside this POC; the
  runner itself only depends on the `AgentResolver` function type, so a dynamic registry would
  plug in there.

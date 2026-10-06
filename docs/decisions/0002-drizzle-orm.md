# 0002: Drizzle instead of Prisma

**Status:** accepted (2026-10-06)

## Context

Both are acceptable. The persistence layer is small (a handful of tables) but its
correctness matters: step checkpoints, a tool-call registry with a uniqueness
constraint, and cost records. Several packages own tables independently.

## Decision

Use Drizzle ORM with `node-postgres`.

- The schema is TypeScript, so there is no code-generation step and no engine binary to
  ship in Docker images or to keep in sync across packages in a monorepo.
- Queries stay close to SQL. `insert ... on conflict do nothing` and `select ... for update`,
  which the idempotency logic relies on, are first-class rather than escape hatches.
- Each package keeps its own `drizzle/` migrations folder and its own migrations table
  (`runMigrations(db, folder, table)` in `@agent-platform/core`), so packages stay independent.

## Consequences

- Migrations are generated with `drizzle-kit generate` and committed as plain SQL.
- Prisma's tooling (Studio, richer relation API) is not available. Not needed for this scope.

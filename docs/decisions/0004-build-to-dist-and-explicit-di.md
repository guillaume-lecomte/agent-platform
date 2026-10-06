# 0004: Packages build to `dist`; Nest uses explicit `@Inject`

**Status:** accepted (2026-10-06)

## Context

Workspace packages can either be consumed from source (`exports` pointing at `.ts`, with every
consumer compiling TypeScript) or be built. NestJS 12 is ESM, and constructor injection by
type needs `emitDecoratorMetadata`, which esbuild/oxc-based tools (Vitest, tsx) do not emit.

## Decision

- Every package compiles with `tsc` to `dist/` and exports from there. Turborepo orders
  builds (`dependsOn: ["^build"]`), and the same artefacts are used locally, in tests,
  in CI and in Docker images.
- Nest providers are injected with explicit `@Inject(TOKEN)`; no decorator metadata is required.

## Consequences

- Tests of a package need its dependencies built first; Turborepo does this automatically
  and caches the result.
- Slightly more verbose controllers and services, but the same code runs under `tsc`,
  `tsx` and Vitest without special transforms.

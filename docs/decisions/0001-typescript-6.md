# 0001: TypeScript 6.0 instead of 7.0

**Status:** accepted (2026-10-06)

## Context

TypeScript 7.0 is the latest stable release at the time of writing. `typescript-eslint`
8.71 declares a peer range of `>=4.8.4 <6.1.0`, and type-aware linting needs the
TypeScript JavaScript API that the 7.x line does not provide in the same form.

## Decision

Pin `typescript` to `~6.0.3` through the pnpm catalog (`pnpm-workspace.yaml`). All
packages consume it with `catalog:`, so the version changes in one place.

## Consequences

- Type-aware lint rules (`no-floating-promises`, etc.) work and `pnpm peers check` is clean.
- We do not get the 7.x compiler speed-ups. The codebase is small enough that this is not felt.
- Revisit when `typescript-eslint` supports 7.x: bump the catalog entry and run `pnpm check`.

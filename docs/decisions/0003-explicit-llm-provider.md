# 0003: The LLM provider is selected explicitly

**Status:** accepted (2026-10-06)

## Context

The brief asks for mock mode by default, with real providers activated "only if a key is
present in the environment". Many developers export `ANTHROPIC_API_KEY` globally. If a
key alone switched the provider, `docker compose up`, tests or the CI evals could silently
start spending money and become non-deterministic.

## Decision

`LLM_PROVIDER` is `mock` (default), `anthropic` or `openai`. A real provider is created only
when it is selected **and** its key is set; selecting one without a key is a startup error
(`loadConfig`). A key present in the environment on its own changes nothing.

## Consequences

- The "clone, run, no API key" path is deterministic regardless of the developer's shell.
- Using a real provider needs one extra, explicit setting. This is a small deviation from
  the literal wording of the brief, chosen to avoid accidental spend.

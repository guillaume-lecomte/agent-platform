# 0007: The mock model follows the prompt, and is not a quality measurement

**Status:** accepted (2026-10-06)

## Context

Evals must run in CI with no API key, and the demo must work offline. Replaying recorded real
answers would need a real key to record them, and would not react to a prompt change, which is
exactly what the eval gate has to catch.

## Decision

In mock mode, the agent's `MockProvider` uses a scripted responder (`agents/issue-triage/src/responder.ts`)
that reads the system prompt for specific instructions ("search for similar issues first", the
`P0:`…`P3:` rubric, "ask for reproduction steps", area labels) and behaves as a model following them
would. Two mock models differ in capability: `mock-small` reads only the title and the first 160
characters of the body, and rarely commits to "duplicate"; `mock-large` reads everything.
Recordings keyed by request hash are still supported (and are how real answers would be recorded
when a key is available), but none are committed.

## Consequences

- A prompt that drops an instruction changes the mock's behaviour, so the pipeline
  (agent → evals → baseline → gate → promote) is exercised end to end, deterministically.
- The scores are **not** evidence about any real model or prompt. Every report says so
  (`simulated: true`, a note in the Markdown summary), and the README repeats it. Measuring a real
  model is what `workflow_dispatch` ("Evals with a real provider") is for.
- The responder is heuristic and imperfect on purpose; it was not tuned to reach 100 %. Two of the 40
  cases fail with v1 and are part of the committed baseline.
- Costs and latencies computed from mock runs are simulated; the cost router's benchmark (v0.4.0)
  labels them accordingly.

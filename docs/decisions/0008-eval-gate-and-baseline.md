# 0008: How the eval gate decides

**Status:** accepted (2026-10-06)

## Context

A prompt or model change can lower quality unnoticed. The gate must catch it without producing
noise that teaches people to ignore it.

## Decision

- A **baseline** (`evals/<agent>/baseline.json`) is committed. It is written only by an explicit
  `evals baseline` command, never as a side effect of a run, so lowering the bar is a visible diff.
- A run fails the gate if the **overall score**, or **any category score present in the baseline**,
  dropped by more than a threshold, in absolute points. Defaults: 3 points overall, 8 per category
  (`gate:` in `suite.yaml`; overridable with `--max-overall-drop` / `--max-category-drop`). A category
  that disappears fails. Improvements never fail.
- The per-category check exists because an average can hide a regression: duplicates can collapse
  while the overall score barely moves.
- Cases are scored 0–1 as the weighted mean of their graders. Graders that cannot run (the LLM
  judge in mock mode) are skipped, flagged in the report, and excluded from the score.
- CI gates the **deployed** version (`active.json`). Other versions touched by a pull request are
  evaluated for information only, otherwise the deliberately degraded `v2` could never be edited.
- `agent promote` runs the same evaluation and refuses to move `active.json` unless it passes,
  or if there is no baseline. `agent rollback` replays the history as a stack, so repeated rollbacks
  walk back one deployment at a time.
- Baselines are mode-specific. A report whose mode differs from the baseline's carries a warning,
  and the real-provider workflow does not compare with the mock baseline.

## Consequences

- Thresholds are a judgement call: with 40 cases, one case moves the overall score by about 2.5
  points, so 3 points tolerates one flaky case but not two.
- Mock-mode evals are deterministic, so a failing gate is always a real change in code or prompt.
  With a real provider, results vary from run to run and thresholds would need to be wider.

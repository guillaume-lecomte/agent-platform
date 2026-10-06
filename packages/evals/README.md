# @agent-platform/evals

Library and CLI to evaluate an agent against a suite of cases, compare with a committed
baseline, and promote or roll back agent versions.

```bash
pnpm evals run --agent issue-triage --version v2     # exit code 1 if the gate fails
pnpm evals run --agent issue-triage --version active # the deployed version (what CI runs)
pnpm evals baseline --agent issue-triage --version v1
pnpm agent promote issue-triage v3                   # only if the evals pass
pnpm agent rollback issue-triage
pnpm agent status issue-triage
```

Reports are written to `evals/<agent>/reports/<version>.json` and `.md` (git-ignored).

## Suite format (`evals/<agent>/suite.yaml`)

```yaml
name: issue-triage
suite_version: 1
agent: issue-triage
output_schema: { type: object, required: [category] } # default schema for json_schema graders
gate: { max_overall_drop: 0.03, max_category_drop: 0.08 }
cases:
  - id: bug-01
    category: bug # scores are also reported per category
    weight: 1
    input: { number: 201, title: '...', body: '...' } # handed to the agent
    graders:
      - { type: exact, path: category, expected: bug, weight: 3 }
      - { type: tool_called, tool: search_similar_issues }
```

| Grader            | Checks                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `exact`           | value at `path` of the JSON answer deep-equals `expected`             |
| `one_of`          | value at `path` equals one of `expected`                              |
| `array_includes`  | array at `path` contains `value`                                      |
| `regex`           | string at `path` matches `pattern` (`flags`, `negate`)                |
| `json_schema`     | the answer validates against `schema`, or the suite's `output_schema` |
| `tool_called`     | the agent requested `tool` between `min` (default 1) and `max` times  |
| `tool_not_called` | the agent never requested `tool`                                      |
| `llm_judge`       | a model grades the answer against `rubric`; skipped in mock mode      |

`path` is a dotted path into the final JSON answer (`labels`, `a.b`); no path means the whole answer.
How the gate decides: [ADR 0008](../../docs/decisions/0008-eval-gate-and-baseline.md).

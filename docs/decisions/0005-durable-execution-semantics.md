# 0005: Durable execution: what is guaranteed, and how

**Status:** accepted (2026-10-06)

## Context

An agent task is a loop of model calls and tool calls that can last minutes and be interrupted at
any point (process killed, deploy, node lost). After an interruption we want to continue, not
restart, and we must never perform a side effect (post a comment) twice.

## Decision

**The step log is the source of truth.** Every model call and every tool result is appended to
`task_steps` (primary key `(task_id, seq)`) in the same transaction that adds its token usage to
the task. The conversation is rebuilt from that log on every iteration, so any worker can pick a
task up with no state other than what is in PostgreSQL.

**BullMQ only schedules.** A job means "advance task X". BullMQ provides the queue, the lock
renewal and the stalled-job detection that re-queues a job whose worker died. Everything that
matters for correctness is in PostgreSQL, so Redis can lose a job without losing a task
(`TaskService.reconcile()` re-wakes tasks whose wake-up was lost between two writes).

**Delivery semantics, per kind of step:**

| Step                            | Guarantee        | Why                                                                                                                                  |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Model call                      | at least once    | A crash between the answer and its checkpoint repeats the call: it costs tokens, nothing else.                                       |
| `read` tool                     | at least once    | Safe to repeat.                                                                                                                      |
| `reversible`/`destructive` tool | **at most once** | Registered in `tool_executions` (key: task + step + hash of tool and arguments) _before_ running; the result is stored when it ends. |

If a worker dies after registering an effectful call but before storing its result, the outcome
is genuinely unknown. The runner does **not** guess: it does not re-run the tool, and tells the
agent "outcome unknown, verify before retrying" (`outcome: unknown`). Tools that talk to external
systems also receive the registry key as `idempotencyKey`, so a downstream system that supports
idempotency keys can turn "at most once" into "exactly once" by letting the agent or a human retry.

**Concurrency without locks.** Two workers can briefly run the same task (a duplicate job, or a
worker that lost its BullMQ lock while still alive). Both append steps with an explicit `seq`; the
primary key lets exactly one win and the other stops quietly (`StepConflictError`). Effects are
protected by the registry, so the loser cannot repeat them. No lease or advisory lock is needed.

**Every state change is a compare-and-set** (`transition(id, from[], to)`), which is what makes
double approval, approve-vs-cancel races and duplicate wake-ups safe.

**Jobs are never deduplicated by task id.** Each wake-up is a distinct job. Deduplicating would
let a job that is still finishing swallow the "resume after approval" wake-up. Duplicates are
harmless by the points above.

## Consequences

- Recovery time after a crash is bounded by BullMQ's lock duration plus stall interval (30 s each
  by default; 3 s and 1 s in the crash demo).
- A model call may be paid twice after a crash. We accept this rather than make the model call
  and its checkpoint atomic, which is impossible with an external API.
- The "unknown outcome" case needs a human or a smarter agent. This is deliberate.
- Tool calls within one model turn run one at a time, in order, each as its own checkpoint.

# HTTP API

Served on port 3000, and also on the dashboard's port under `/api`. No authentication. Errors are JSON
(`{ "error", "message" }`): 400 invalid input, 404 unknown id, 409 impossible transition (for example
deciding an approval twice).

| Method and path               | Purpose                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /tasks`                 | Create a task: `{ "input": { "title", "body" }, "agentId"?, "agentVersion"?, "tokenBudget"?, "idempotencyKey"? }`. `201` for a new task, `200` if the idempotency key (body or `Idempotency-Key` header) was already used. |
| `GET /tasks`                  | Latest tasks (`?limit=`)                                                                                                                                                                                                   |
| `GET /tasks/:id`              | One task: state, token usage, result, error                                                                                                                                                                                |
| `GET /tasks/:id/steps`        | The step log: model calls and tool results                                                                                                                                                                                 |
| `POST /tasks/:id/cancel`      | Cancel a task (immediately if idle or waiting for approval, at the next step if running)                                                                                                                                   |
| `GET /approvals`              | Approvals, filtered by `?status=pending\|approved\|denied` and `?taskId=`                                                                                                                                                  |
| `POST /approvals/:id/approve` | `{ "reason"? }`                                                                                                                                                                                                            |
| `POST /approvals/:id/deny`    | `{ "reason" }`, required. The agent receives it as the tool result.                                                                                                                                                        |
| `GET /events`                 | Server-sent events: one message per task lifecycle event                                                                                                                                                                   |
| `GET /agents`                 | Hosted agents and their deployed version                                                                                                                                                                                   |
| `GET /costs`                  | Cost and latency per model, with the price list and its sources. `simulated` is true when the mock provider was used                                                                                                       |
| `GET /costs/calls`            | Recent model calls (`?limit=`)                                                                                                                                                                                             |
| `GET /metrics`                | Prometheus metrics                                                                                                                                                                                                         |
| `GET /health`                 | PostgreSQL and Redis status                                                                                                                                                                                                |

```bash
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"input":{"title":"Login button does nothing in Firefox","body":"No effect on click. Version 2.4.1."}}'
curl -s 'localhost:3000/approvals?status=pending'
curl -s -X POST localhost:3000/approvals/<id>/approve -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:3000/approvals/<id>/deny -H 'content-type: application/json' -d '{"reason":"too chatty"}'
```

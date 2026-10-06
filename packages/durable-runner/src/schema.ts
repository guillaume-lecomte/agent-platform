import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    agentId: text('agent_id').notNull(),
    agentVersion: text('agent_version').notNull(),
    input: jsonb('input').notNull(),
    state: text('state').notNull().default('pending'),
    tokenBudget: integer('token_budget').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    result: jsonb('result'),
    error: text('error'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('agent_tasks_state_idx').on(t.state),
    index('agent_tasks_created_idx').on(t.createdAt),
  ],
);

export const taskSteps = pgTable(
  'task_steps',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  // The primary key is what makes concurrent writers of the same step collide.
  (t) => [primaryKey({ columns: [t.taskId, t.seq] })],
);

/** Registry of tool calls: the guarantee that an effectful tool is never run twice. */
export const toolExecutions = pgTable(
  'tool_executions',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    stepSeq: integer('step_seq').notNull(),
    argsHash: text('args_hash').notNull(),
    toolName: text('tool_name').notNull(),
    risk: text('risk').notNull(),
    status: text('status').notNull(),
    result: text('result'),
    isError: boolean('is_error').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.stepSeq, t.argsHash] })],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    stepSeq: integer('step_seq').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    arguments: jsonb('arguments').notNull(),
    risk: text('risk').notNull(),
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [
    unique('approvals_call_unique').on(t.taskId, t.stepSeq, t.toolCallId),
    index('approvals_status_idx').on(t.status),
  ],
);

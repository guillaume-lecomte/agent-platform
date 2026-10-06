import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** One row per model attempt (a fallback produces two rows: the failed one and the answer). */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    taskId: text('task_id'),
    agentId: text('agent_id'),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    rule: text('rule').notNull(),
    complexity: text('complexity').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Null when the model has no price: unknown, not free. */
    costUsd: doublePrecision('cost_usd'),
    savedUsd: doublePrecision('saved_usd').notNull().default(0),
    latencyMs: doublePrecision('latency_ms').notNull(),
    simulated: boolean('simulated').notNull().default(false),
    cacheHit: boolean('cache_hit').notNull().default(false),
    fallbackFrom: text('fallback_from'),
    status: text('status').notNull(),
    error: text('error'),
  },
  (t) => [index('llm_calls_at_idx').on(t.at), index('llm_calls_model_idx').on(t.model)],
);

/**
 * A standalone BullMQ worker, started by the crash demo (and usable on its own:
 * `pnpm --filter @agent-platform/scripts exec tsx worker-process.ts`).
 * It builds the same runner as the API, so killing it exercises the real recovery path.
 */
import {
  PgEffectLog,
  issueTriageResponder,
  resolveIssueTriage,
} from '@agent-platform/agent-issue-triage';
import { MockProvider, createDb, createLogger } from '@agent-platform/core';
import {
  AgentRunner,
  PgTaskStore,
  RedisEventBus,
  TaskWorker,
  migrateRunner,
} from '@agent-platform/durable-runner';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

const logger = createLogger({ name: `worker:${process.pid}`, level: env('LOG_LEVEL', 'info') });
const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
const { db, pool, close } = createDb(
  env('DATABASE_URL', 'postgres://agent:agent@localhost:5432/agent_platform'),
);

await migrateRunner(db);
const effects = new PgEffectLog(pool);
const bus = new RedisEventBus(redisUrl);
const runner = new AgentRunner({
  store: new PgTaskStore(db),
  bus,
  logger,
  resolver: async (_agentId, version) => resolveIssueTriage(version, effects),
  provider: new MockProvider({
    responder: issueTriageResponder,
    realDelayMs: Number(env('MOCK_DELAY_MS', '0')),
  }),
});
const worker = new TaskWorker({
  redisUrl,
  queueName: env('QUEUE_NAME', 'agent-tasks'),
  runner,
  logger,
  concurrency: 1,
  lockDurationMs: Number(env('LOCK_MS', '30000')),
  stalledIntervalMs: Number(env('STALLED_MS', '30000')),
});
logger.info('worker ready');

const shutdown = async (): Promise<void> => {
  await worker.close();
  await bus.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

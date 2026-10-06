import { issueTriageResponder } from '@agent-platform/agent-issue-triage';
import { createProvider, type Config, type DbHandle, type Logger } from '@agent-platform/core';
import {
  AgentRunner,
  PgTaskStore,
  RedisEventBus,
  TaskQueue,
  TaskService,
  TaskWorker,
  migrateRunner,
  type EventBus,
  type TaskStore,
} from '@agent-platform/durable-runner';
import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createAgentCatalog, type AgentCatalog } from './agents.js';
import {
  AGENTS,
  BUS,
  CONFIG,
  DB,
  LOGGER,
  METRICS,
  RUNNER,
  STORE,
  TASK_SERVICE,
} from './infra/tokens.js';
import { MetricsService } from './metrics/metrics.service.js';

const QUEUE = Symbol('QUEUE');
const WORKER = Symbol('WORKER');

/**
 * Wires the durable runner: PostgreSQL store, Redis bus and queue, and an in-process
 * BullMQ worker. Workers can also run as separate processes (see scripts/crash-demo.ts);
 * everything they share lives in PostgreSQL and Redis.
 */
@Global()
@Module({
  providers: [
    {
      provide: STORE,
      inject: [DB],
      useFactory: (db: DbHandle): TaskStore => new PgTaskStore(db.db),
    },
    {
      provide: BUS,
      inject: [CONFIG],
      useFactory: (c: Config): EventBus => new RedisEventBus(c.REDIS_URL),
    },
    {
      provide: AGENTS,
      inject: [DB],
      useFactory: (db: DbHandle): AgentCatalog => createAgentCatalog(db.pool),
    },
    {
      provide: METRICS,
      inject: [STORE],
      useFactory: (store: TaskStore) => new MetricsService(store),
    },
    {
      provide: RUNNER,
      inject: [STORE, BUS, AGENTS, LOGGER, CONFIG, METRICS],
      useFactory: (
        store: TaskStore,
        bus: EventBus,
        agents: AgentCatalog,
        logger: Logger,
        config: Config,
        metrics: MetricsService,
      ) =>
        new AgentRunner({
          store,
          bus,
          logger,
          resolver: agents.resolver,
          provider: createProvider(config, { mockResponder: issueTriageResponder }),
          hooks: metrics.hooks,
        }),
    },
    {
      provide: QUEUE,
      inject: [CONFIG],
      useFactory: (c: Config) => new TaskQueue({ redisUrl: c.REDIS_URL }),
    },
    {
      provide: WORKER,
      inject: [CONFIG, RUNNER, LOGGER],
      useFactory: (c: Config, runner: AgentRunner, logger: Logger) =>
        new TaskWorker({ redisUrl: c.REDIS_URL, runner, logger }),
    },
    {
      provide: TASK_SERVICE,
      inject: [STORE, QUEUE, BUS, AGENTS, LOGGER, RUNNER],
      useFactory: (
        store: TaskStore,
        queue: TaskQueue,
        bus: EventBus,
        agents: AgentCatalog,
        logger: Logger,
        runner: AgentRunner,
      ) =>
        new TaskService({
          store,
          scheduler: queue,
          bus,
          resolver: agents.resolver,
          activeVersion: agents.activeVersion,
          logger,
          runner,
        }),
    },
  ],
  exports: [STORE, BUS, AGENTS, METRICS, RUNNER, TASK_SERVICE],
})
export class RunnerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(TASK_SERVICE) private readonly service: TaskService,
    @Inject(WORKER) private readonly worker: TaskWorker,
    @Inject(QUEUE) private readonly queue: TaskQueue,
    @Inject(BUS) private readonly bus: EventBus,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await migrateRunner(this.db.db);
    const woken = await this.service.reconcile();
    if (woken > 0) this.logger.info({ woken }, 'reconciled tasks with a lost wake-up');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.bus.close();
  }
}

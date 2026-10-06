import { issueTriageResponder } from '@agent-platform/agent-issue-triage';
import {
  CompositeTracker,
  CostRouter,
  PgCallTracker,
  RedisResponseCache,
  RouterMetrics,
  loadPolicy,
  loadPricing,
  migrateRouter,
  mockLatencyFromPricing,
  type PricingTable,
  type QueryableTracker,
} from '@agent-platform/cost-router';
import { createProvider, type Config, type DbHandle, type Logger } from '@agent-platform/core';
import { join, resolve } from 'node:path';
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
  COST_TRACKER,
  DB,
  LOGGER,
  METRICS,
  PRICING,
  ROUTER,
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
      provide: PRICING,
      inject: [CONFIG],
      useFactory: (c: Config): Promise<PricingTable> =>
        loadPricing(resolve(c.CONFIG_DIR, 'pricing.yaml')),
    },
    {
      provide: COST_TRACKER,
      inject: [DB],
      useFactory: (db: DbHandle): QueryableTracker => new PgCallTracker(db.db),
    },
    {
      provide: ROUTER,
      inject: [CONFIG, PRICING, COST_TRACKER, METRICS, LOGGER],
      useFactory: async (
        c: Config,
        pricing: PricingTable,
        tracker: QueryableTracker,
        metrics: MetricsService,
        logger: Logger,
      ) => {
        const policy = await loadPolicy(join(resolve(c.CONFIG_DIR), c.ROUTER_POLICY));
        // One real or mock provider; the router picks the model per request.
        const base = createProvider(c, {
          mockResponder: issueTriageResponder,
          mockSimulatedLatency: mockLatencyFromPricing(pricing),
        });
        return new CostRouter({
          providers: { [c.LLM_PROVIDER]: base },
          pricing,
          policy,
          cache: new RedisResponseCache(c.REDIS_URL),
          tracker: new CompositeTracker([tracker, new RouterMetrics(metrics.registry)], (err) =>
            logger.warn({ err: String(err) }, 'cost tracking failed'),
          ),
          logger,
        });
      },
    },
    {
      provide: RUNNER,
      inject: [STORE, BUS, AGENTS, LOGGER, ROUTER, METRICS],
      useFactory: (
        store: TaskStore,
        bus: EventBus,
        agents: AgentCatalog,
        logger: Logger,
        router: CostRouter,
        metrics: MetricsService,
      ) =>
        new AgentRunner({
          store,
          bus,
          logger,
          resolver: agents.resolver,
          provider: router,
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
  exports: [STORE, BUS, AGENTS, METRICS, RUNNER, TASK_SERVICE, ROUTER, COST_TRACKER, PRICING],
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
    await migrateRouter(this.db.db);
    const woken = await this.service.reconcile();
    if (woken > 0) this.logger.info({ woken }, 'reconciled tasks with a lost wake-up');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.bus.close();
  }
}

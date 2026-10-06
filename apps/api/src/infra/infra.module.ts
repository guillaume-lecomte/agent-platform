import {
  createDb,
  createLogger,
  loadConfig,
  type Config,
  type DbHandle,
} from '@agent-platform/core';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { CONFIG, DB, LOGGER, REDIS } from './tokens.js';

/** Process-wide infrastructure: validated config, logger, PostgreSQL pool, Redis connection. */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    {
      provide: LOGGER,
      inject: [CONFIG],
      useFactory: (config: Config) => createLogger({ name: 'api', level: config.LOG_LEVEL }),
    },
    {
      provide: DB,
      inject: [CONFIG],
      useFactory: (config: Config): DbHandle => createDb(config.DATABASE_URL),
    },
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (config: Config) => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    },
  ],
  exports: [CONFIG, LOGGER, DB, REDIS],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.db.close(), this.redis.quit()]);
  }
}

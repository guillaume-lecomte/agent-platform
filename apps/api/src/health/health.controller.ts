import type { DbHandle } from '@agent-platform/core';
import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DB, REDIS } from '../infra/tokens.js';

type CheckResult = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<{ status: 'ok'; checks: Record<string, CheckResult> }> {
    const [postgres, redis] = await Promise.all([
      this.probe(async () => {
        await this.db.pool.query('select 1');
      }),
      this.probe(async () => {
        await this.redis.ping();
      }),
    ]);
    const checks = { postgres, redis };
    if (postgres === 'down' || redis === 'down') {
      throw new HttpException({ status: 'degraded', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', checks };
  }

  private async probe(fn: () => Promise<void>): Promise<CheckResult> {
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}

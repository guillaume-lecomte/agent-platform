import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from '../src/health/health.controller.js';
import { DB, REDIS } from '../src/infra/tokens.js';

async function startApp(opts: { pgUp: boolean; redisUp: boolean }): Promise<{
  app: INestApplication;
  url: string;
}> {
  const db = {
    pool: {
      query: () => (opts.pgUp ? Promise.resolve() : Promise.reject(new Error('pg down'))),
    },
  };
  const redis = {
    ping: () => (opts.redisUp ? Promise.resolve('PONG') : Promise.reject(new Error('x'))),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DB, useValue: db },
      { provide: REDIS, useValue: redis },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return { app, url: await app.getUrl() };
}

describe('GET /health', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('reports ok when postgres and redis answer', async () => {
    const started = await startApp({ pgUp: true, redisUp: true });
    app = started.app;
    const res = await fetch(`${started.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('returns 503 naming the failing dependency', async () => {
    const started = await startApp({ pgUp: true, redisUp: false });
    app = started.app;
    const res = await fetch(`${started.url}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded', checks: { redis: 'down' } });
  });
});

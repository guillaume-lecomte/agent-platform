import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CostsController } from '../src/costs/costs.controller.js';
import { HealthController } from '../src/health/health.controller.js';
import { MetricsController } from '../src/metrics/metrics.controller.js';
import { AgentsController } from '../src/tasks/agents.controller.js';
import { EventsController } from '../src/tasks/events.controller.js';
import { TasksController } from '../src/tasks/tasks.controller.js';

describe('AppModule', () => {
  it('registers every controller (the e2e tests build their own module, so check the real one)', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    for (const c of [
      HealthController,
      TasksController,
      EventsController,
      AgentsController,
      MetricsController,
      CostsController,
    ]) {
      expect(controllers, c.name).toContain(c);
    }
  });
});

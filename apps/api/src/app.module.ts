import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CostsController } from './costs/costs.controller.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './http-exceptions.js';
import { InfraModule } from './infra/infra.module.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { RunnerModule } from './runner.module.js';
import { AgentsController } from './tasks/agents.controller.js';
import { EventsController } from './tasks/events.controller.js';
import { TasksController } from './tasks/tasks.controller.js';

@Module({
  imports: [InfraModule, RunnerModule],
  controllers: [
    HealthController,
    TasksController,
    EventsController,
    AgentsController,
    MetricsController,
    CostsController,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}

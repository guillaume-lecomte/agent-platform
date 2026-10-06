import { Controller, Get, Header, Inject } from '@nestjs/common';
import { METRICS } from '../infra/tokens.js';
import type { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  render(): Promise<string> {
    return this.metrics.render();
  }
}

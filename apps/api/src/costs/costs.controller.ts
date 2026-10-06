import type { PricingTable, QueryableTracker } from '@agent-platform/cost-router';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { COST_TRACKER, PRICING } from '../infra/tokens.js';

@Controller('costs')
export class CostsController {
  constructor(
    @Inject(COST_TRACKER) private readonly tracker: QueryableTracker,
    @Inject(PRICING) private readonly pricing: PricingTable,
  ) {}

  /**
   * Cost and latency per model. `simulated` is true when any call came from the mock provider:
   * tokens and latencies are then simulated and prices illustrative. The price list the
   * costs were computed from (with sources and dates) is included for transparency.
   */
  @Get()
  async summary() {
    return {
      ...(await this.tracker.summary()),
      pricing: {
        updated: this.pricing.updated,
        currency: this.pricing.currency,
        perTokens: this.pricing.per_tokens,
        models: Object.entries(this.pricing.models).map(([model, m]) => ({
          model,
          provider: m.provider,
          input: m.input,
          output: m.output,
          simulated: m.simulated,
          source: m.source,
          retrieved: m.retrieved,
        })),
      },
    };
  }

  @Get('calls')
  recent(@Query('limit') limit?: string) {
    return this.tracker.recent(Math.min(Number(limit) || 50, 500));
  }
}

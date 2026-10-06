import { Controller, Get, Inject } from '@nestjs/common';
import type { AgentCatalog } from '../agents.js';
import { AGENTS } from '../infra/tokens.js';

@Controller('agents')
export class AgentsController {
  constructor(@Inject(AGENTS) private readonly agents: AgentCatalog) {}

  @Get()
  async list() {
    return Promise.all(
      this.agents.ids.map(async (id) => ({
        id,
        activeVersion: await this.agents.activeVersion(id),
      })),
    );
  }
}

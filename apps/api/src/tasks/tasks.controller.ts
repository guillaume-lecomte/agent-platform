import type { TaskService } from '@agent-platform/durable-runner';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { TASK_SERVICE } from '../infra/tokens.js';

const createSchema = z.object({
  agentId: z.string().min(1).default('issue-triage'),
  agentVersion: z
    .string()
    .regex(/^v\d+$/)
    .optional(),
  input: z.unknown(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  tokenBudget: z.number().int().positive().optional(),
});

const decisionSchema = z.object({ reason: z.string().max(1000).optional() });
const denySchema = z.object({
  reason: z.string().trim().min(1, 'a reason is required to deny').max(1000),
});

@Controller()
export class TasksController {
  constructor(@Inject(TASK_SERVICE) private readonly service: TaskService) {}

  /** Creates a task. Repeating an Idempotency-Key returns the original task with 200. */
  @Post('tasks')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') headerKey: string | undefined,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    const parsed = createSchema.parse(body ?? {});
    const { task, created } = await this.service.createTask({
      agentId: parsed.agentId,
      input: parsed.input,
      agentVersion: parsed.agentVersion,
      tokenBudget: parsed.tokenBudget,
      ...((parsed.idempotencyKey ?? headerKey)
        ? { idempotencyKey: (parsed.idempotencyKey ?? headerKey)! }
        : {}),
    });
    res.status(created ? 201 : 200);
    return task;
  }

  @Get('tasks')
  list(@Query('limit') limit?: string) {
    return this.service.listTasks({ limit: Math.min(Number(limit) || 100, 500) });
  }

  @Get('tasks/:id')
  get(@Param('id') id: string) {
    return this.service.getTask(id);
  }

  @Get('tasks/:id/steps')
  steps(@Param('id') id: string) {
    return this.service.getSteps(id);
  }

  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }

  @Get('approvals')
  approvals(@Query('status') status?: string, @Query('taskId') taskId?: string) {
    const parsed = z.enum(['pending', 'approved', 'denied']).optional().parse(status);
    return this.service.listApprovals({
      status: parsed,
      ...(taskId ? { taskId } : {}),
    });
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown) {
    return this.service.approve(id, decisionSchema.parse(body ?? {}).reason);
  }

  @Post('approvals/:id/deny')
  @HttpCode(200)
  deny(@Param('id') id: string, @Body() body: unknown) {
    return this.service.deny(id, denySchema.parse(body ?? {}).reason);
  }
}

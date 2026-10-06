import type { TaskService } from '@agent-platform/durable-runner';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
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
  tokenBudget: z.number().int().positive().max(1_000_000).optional(),
});

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const statusSchema = z.object({ status: z.enum(['pending', 'approved', 'denied']).optional() });
const uuid = new ParseUUIDPipe({ version: '4' });

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
      idempotencyKey: parsed.idempotencyKey ?? headerKey,
    });
    res.status(created ? 201 : 200);
    return task;
  }

  @Get('tasks')
  list(@Query('limit') limit?: string) {
    return this.service.listTasks({ limit: listSchema.parse({ limit }).limit });
  }

  @Get('tasks/:id')
  get(@Param('id', uuid) id: string) {
    return this.service.getTask(id);
  }

  @Get('tasks/:id/steps')
  steps(@Param('id', uuid) id: string) {
    return this.service.getSteps(id);
  }

  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', uuid) id: string) {
    return this.service.cancel(id);
  }

  @Get('approvals')
  approvals(
    @Query('status') status?: string,
    @Query('taskId', new ParseUUIDPipe({ version: '4', optional: true })) taskId?: string,
  ) {
    return this.service.listApprovals({ status: statusSchema.parse({ status }).status, taskId });
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  approve(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.approve(id, decisionSchema.parse(body ?? {}).reason);
  }

  @Post('approvals/:id/deny')
  @HttpCode(200)
  deny(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.deny(id, denySchema.parse(body ?? {}).reason);
  }
}

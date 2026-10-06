import { ConflictError, NotFoundError } from '@agent-platform/durable-runner';
import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ZodError } from 'zod';

/** Maps domain errors to HTTP statuses so controllers stay free of try/catch. */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    if (err instanceof HttpException) {
      res.status(err.getStatus()).json(err.getResponse());
    } else if (err instanceof NotFoundError) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'not_found', message: err.message });
    } else if (err instanceof ConflictError) {
      res.status(HttpStatus.CONFLICT).json({ error: 'conflict', message: err.message });
    } else if (err instanceof ZodError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'invalid_request',
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    } else {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'unexpected error',
      });
    }
  }
}

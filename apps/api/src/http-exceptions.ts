import { ConflictError, NotFoundError } from '@agent-platform/durable-runner';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ZodError } from 'zod';

/** Maps domain errors to HTTP statuses so controllers stay free of try/catch. */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptions');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    if (err instanceof HttpException) {
      res.status(err.getStatus()).json(normalize(err));
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
      // Unexpected: log the details, but do not send internals (SQL, stack) to the client.
      this.logger.error(
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : undefined,
      );
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: 'internal_error',
        message: 'Unexpected error. See the server logs.',
      });
    }
  }
}

/**
 * Nest's own errors (bad JSON, ParseUUIDPipe...) use `{ statusCode, message, error }`; reshape them
 * to the `{ error, message }` used everywhere else. Bodies without a message (the health check's
 * 503) are passed through.
 */
function normalize(err: HttpException): unknown {
  const body = err.getResponse();
  if (typeof body === 'string') return { error: snake(err.name), message: body };
  const { message } = body as { message?: unknown };
  if (message === undefined) return body;
  return {
    error: HTTP_ERROR[err.getStatus()] ?? 'error',
    message: Array.isArray(message)
      ? message.join('; ')
      : typeof message === 'string'
        ? message
        : JSON.stringify(message),
  };
}

const HTTP_ERROR: Record<number, string> = {
  400: 'invalid_request',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
};

const snake = (name: string): string =>
  name
    .replace(/Exception$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();

import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

export interface LoggerOptions {
  name?: string;
  level?: string;
}

/** Structured JSON logger (pino). Secrets are redacted by key name. */
export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    name: options.name ?? 'agent-platform',
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: ['*.apiKey', '*.api_key', '*.authorization', 'apiKey', 'authorization', '*.password'],
      censor: '[redacted]',
    },
  });
}

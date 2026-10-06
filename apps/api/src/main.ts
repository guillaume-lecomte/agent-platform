import 'reflect-metadata';
import { createLogger, loadConfig } from '@agent-platform/core';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { PinoNestLogger } from './pino-logger.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ name: 'api', level: config.LOG_LEVEL });
  const app = await NestFactory.create(AppModule, { logger: new PinoNestLogger(logger) });
  // The API has no authentication (documented limit of the POC), so CORS is open too.
  app.enableCors();
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT, llmProvider: config.LLM_PROVIDER }, 'api listening');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

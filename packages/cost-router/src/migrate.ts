import { runMigrations, type Database } from '@agent-platform/core';
import { fileURLToPath } from 'node:url';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export function migrateRouter(db: Database): Promise<void> {
  return runMigrations(db, migrationsFolder, '__migrations_cost_router');
}

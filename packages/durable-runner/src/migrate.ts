import { runMigrations, type Database } from '@agent-platform/core';
import { fileURLToPath } from 'node:url';

/** Folder of generated SQL migrations, shipped with the package. */
export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export function migrateRunner(db: Database): Promise<void> {
  return runMigrations(db, migrationsFolder, '__migrations_durable_runner');
}

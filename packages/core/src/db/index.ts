import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export type Database = NodePgDatabase;

export interface DbHandle {
  pool: pg.Pool;
  db: Database;
  close: () => Promise<void>;
}

export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return { pool, db: drizzle(pool), close: () => pool.end() };
}

/**
 * Applies the SQL migrations of one package. Each package keeps its own migrations
 * folder and its own bookkeeping table, so packages evolve their schema independently.
 */
export async function runMigrations(
  db: Database,
  migrationsFolder: string,
  migrationsTable: string,
): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsTable });
}

import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Applies any pending migrations before the engine does anything else.
 * Runs identically whether Postgres is the bundled container or an
 * external instance the user already runs — there's no special-casing
 * for "first boot" here, node-pg-migrate tracks what's already applied
 * in its own `pgmigrations` table and this is a no-op once everything's
 * current. This replaces the old approach of mounting schema.sql into
 * Postgres's docker-entrypoint-initdb.d, which only ever worked for the
 * bundled database and never for an external one.
 */
export async function runMigrations(): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

  await runner({
    databaseUrl: process.env.DATABASE_URL!,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    checkOrder: true,
    log: (msg: string) => console.log(`[migrate] ${msg}`),
  });
}

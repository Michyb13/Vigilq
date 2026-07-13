import { Kysely, PostgresDialect, Generated } from "kysely";
import { Pool } from "pg";

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter";

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  created_at: Generated<Date>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  tenant_id: string;
  key_hash: string;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface JobsTable {
  id: Generated<string>;
  tenant_id: string;
  job_type: string;
  payload: unknown; // JSONB
  status: Generated<JobStatus>;
  priority: Generated<number>;
  pool: string | null;
  dedupe_key: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: Generated<Date>;
  locked_by: string | null;
  locked_until: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  completed_at: Date | null;
}

export interface JobAttemptsTable {
  id: Generated<string>;
  job_id: string;
  attempt_number: number;
  worker_id: string;
  started_at: Generated<Date>;
  finished_at: Date | null;
  outcome: "success" | "failure" | null;
  error_message: string | null;
  error_stack: string | null;
}

export interface JobTypeStatsTable {
  tenant_id: string;
  job_type: string;
  attempt_number: number;
  success_count: Generated<number>;
  failure_count: Generated<number>;
  avg_duration_ms: number | null;
  updated_at: Generated<Date>;
}

export interface DeadLetterTriageTable {
  job_id: string;
  classification: string;
  suggested_fix: string | null;
  confidence: number | null;
  model_used: string;
  created_at: Generated<Date>;
}

export interface PoolAutoscaleConfigTable {
  tenant_id: string;
  pool: string;
  provider: Generated<"docker" | "kubernetes" | "runpod">;
  min_workers: Generated<number>;
  max_workers: Generated<number>;
  scale_up_threshold: Generated<number>;
  scale_down_idle_minutes: Generated<number>;
  updated_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  api_keys: ApiKeysTable;
  jobs: JobsTable;
  job_attempts: JobAttemptsTable;
  job_type_stats: JobTypeStatsTable;
  dead_letter_triage: DeadLetterTriageTable;
  pool_autoscale_config: PoolAutoscaleConfigTable;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Retries a connection until Postgres actually accepts one, instead of
 * failing immediately on the engine's first query. This matters even
 * outside Docker: nothing in this project uses `depends_on` to sequence
 * the engine after the bundled `db` service, on purpose — `depends_on`
 * referencing a profile-gated service breaks the "point at your own
 * Postgres instead" mode entirely, since that service doesn't exist
 * outside the `bundled-db` profile. Retrying here handles the startup
 * race universally, regardless of deployment topology.
 */
export async function waitForDatabase(maxAttempts = 15, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sqlSelectOne();
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(`Could not reach the database after ${maxAttempts} attempts: ${(err as Error).message}`);
      }
      console.log(`[db] not ready yet (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function sqlSelectOne(): Promise<void> {
  await db.selectNoFrom((eb) => eb.lit(1).as("ok")).execute();
}

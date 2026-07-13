import { Transaction, sql } from "kysely";
import { Database } from "./db.js";
import { computeBackoffMs } from "./queue.js";

/** Minimum sample size before trusting stats over the plain static curve. */
const MIN_SAMPLES = 8;

/**
 * Record the outcome of one attempt, bucketed by (tenant, job_type,
 * attempt_number). This is the raw data adaptive backoff reasons from: e.g.
 * "attempt 2 of send_email succeeds 90% of the time" vs. "attempt 2 of
 * flaky_import succeeds 10% of the time" — two job types that should not
 * share the same retry timing, even though the static exponential curve
 * would treat them identically.
 */
export async function recordAttemptStats(
  trx: Transaction<Database>,
  tenantId: string,
  jobType: string,
  attemptNumber: number,
  outcome: "success" | "failure"
): Promise<void> {
  await trx
    .insertInto("job_type_stats")
    .values({
      tenant_id: tenantId,
      job_type: jobType,
      attempt_number: attemptNumber,
      success_count: outcome === "success" ? 1 : 0,
      failure_count: outcome === "failure" ? 1 : 0,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "job_type", "attempt_number"]).doUpdateSet({
        success_count: sql`job_type_stats.success_count + excluded.success_count`,
        failure_count: sql`job_type_stats.failure_count + excluded.failure_count`,
        updated_at: sql`now()`,
      })
    )
    .execute();
}

/**
 * Adaptive backoff: pull this job type's historical success rate for the
 * attempt it's about to retry at, and scale the normal exponential-backoff
 * curve by it.
 *
 *  - High historical success rate at this attempt (jobs that tend to
 *    recover quickly, e.g. a flaky third-party API) -> shorter wait, retry
 *    sooner since it's likely to just work.
 *  - Low historical success rate (jobs that keep failing regardless of how
 *    long you wait, e.g. a genuinely broken payload/integration) -> longer
 *    wait, since hammering it on a short timer wastes worker capacity for
 *    little chance of success.
 *  - Not enough data yet (a new job type, or one that hasn't failed enough
 *    times to be statistically meaningful) -> fall back to the plain static
 *    curve unchanged.
 */
export async function computeAdaptiveBackoffMs(
  trx: Transaction<Database>,
  tenantId: string,
  jobType: string,
  attempt: number
): Promise<number> {
  const baseline = computeBackoffMs(attempt);

  const stats = await trx
    .selectFrom("job_type_stats")
    .select(["success_count", "failure_count"])
    .where("tenant_id", "=", tenantId)
    .where("job_type", "=", jobType)
    .where("attempt_number", "=", attempt)
    .executeTakeFirst();

  if (!stats) return baseline;

  // pg returns BIGINT columns as strings (to avoid precision loss beyond
  // Number.MAX_SAFE_INTEGER), so these must be parsed before arithmetic —
  // otherwise `+` silently concatenates ("9" + "2" -> "92") instead of
  // adding, corrupting every rate calculation downstream.
  const successCount = Number(stats.success_count);
  const failureCount = Number(stats.failure_count);

  const totalSamples = successCount + failureCount;
  if (totalSamples < MIN_SAMPLES) return baseline;

  const successRate = successCount / totalSamples;

  // Scale the static curve by success rate: 0% success -> up to 2x longer,
  // 100% success -> as short as half. Clamped so it never goes to zero or
  // explodes to an unreasonable multiple of the static value.
  const scale = 2 - successRate * 1.5; // successRate=0 -> 2.0x, successRate=1 -> 0.5x
  const scaled = Math.floor(baseline * scale);

  const minMs = 500;
  const maxMs = 10 * 60_000;
  return Math.min(Math.max(scaled, minMs), maxMs);
}

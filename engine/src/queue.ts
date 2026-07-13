import { sql } from "kysely";
import { db, JobStatus } from "./db.js";
import { recordAttemptStats, computeAdaptiveBackoffMs } from "./adaptiveBackoff.js";
import { triageDeadLetterJobInBackground } from "./triage/index.js";

export interface EnqueueOptions {
  pool?: string;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
  runAfter?: Date;
}

export interface ClaimOptions {
  pool?: string; // if set, this worker only takes jobs for this pool (or unassigned jobs)
  jobTypes?: string[]; // if set, only claim these job types
  leaseSeconds?: number; // how long this worker holds the job before it's considered dead
}

/**
 * Insert a new job. If dedupeKey is set and a non-terminal job with the same
 * (tenant, job_type, dedupeKey) already exists, this is a no-op — returns null.
 */
export async function enqueue(
  tenantId: string,
  jobType: string,
  payload: unknown,
  opts: EnqueueOptions = {}
) {
  const row = await db
    .insertInto("jobs")
    .values({
      tenant_id: tenantId,
      job_type: jobType,
      payload: JSON.stringify(payload),
      pool: opts.pool ?? null,
      priority: opts.priority ?? 0,
      max_attempts: opts.maxAttempts ?? 5,
      dedupe_key: opts.dedupeKey ?? null,
      run_after: opts.runAfter ?? new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns(["tenant_id", "job_type", "dedupe_key"])
        .where("dedupe_key", "is not", null)
        .doNothing()
    )
    .returningAll()
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Atomically claim one pending, due job. This is the one query the whole
 * queue's correctness rests on: SELECT ... FOR UPDATE SKIP LOCKED means two
 * workers running this at the same instant can never grab the same row —
 * the second one's subquery just skips past the row the first one locked
 * and finds the next candidate instead.
 */
export async function claimJob(tenantId: string, workerId: string, opts: ClaimOptions = {}) {
  const leaseSeconds = opts.leaseSeconds ?? 30;

  const claimed = await db
    .updateTable("jobs")
    .set({
      status: "running" as JobStatus,
      locked_by: workerId,
      locked_until: sql`now() + make_interval(secs => ${leaseSeconds})`,
      attempts: sql`attempts + 1`,
      updated_at: sql`now()`,
    })
    .where("id", "=", (eb) => {
      let subquery = eb
        .selectFrom("jobs")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "pending")
        .where(sql<boolean>`run_after <= now()`);

      if (opts.pool) {
        const pool = opts.pool;
        subquery = subquery.where((eb2) =>
          eb2.or([eb2("pool", "=", pool), eb2("pool", "is", null)])
        );
      }

      if (opts.jobTypes && opts.jobTypes.length > 0) {
        subquery = subquery.where("job_type", "in", opts.jobTypes);
      }

      return subquery
        .orderBy("priority", "desc")
        .orderBy("run_after", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked();
    })
    .returningAll()
    .executeTakeFirst();

  return claimed ?? null;
}

/** Tenant-scoped lookup — the API uses this to verify a job belongs to the
 * caller's tenant before letting them complete/fail/renew it, so one
 * tenant can never act on another tenant's job by guessing an id. */
export async function getJobById(tenantId: string, jobId: string) {
  const row = await db
    .selectFrom("jobs")
    .selectAll()
    .where("id", "=", jobId)
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();

  return row ?? null;
}

export async function listJobs(
  tenantId: string,
  filters: { status?: JobStatus; pool?: string; jobType?: string; limit?: number } = {}
) {
  let query = db.selectFrom("jobs").selectAll().where("tenant_id", "=", tenantId);

  if (filters.status) query = query.where("status", "=", filters.status);
  if (filters.pool) query = query.where("pool", "=", filters.pool);
  if (filters.jobType) query = query.where("job_type", "=", filters.jobType);

  return query
    .orderBy("created_at", "desc")
    .limit(filters.limit ?? 50)
    .execute();
}

/** Pending-job count per pool — what the autoscaler polls to decide when to scale. */
export async function getPoolDepths(tenantId: string) {
  return db
    .selectFrom("jobs")
    .select(["pool", db.fn.countAll().as("pending_count")])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "pending")
    .groupBy("pool")
    .execute();
}

/** Job count per status — the dashboard's overview tiles. */
export async function getStatusCounts(tenantId: string) {
  return db
    .selectFrom("jobs")
    .select(["status", db.fn.countAll().as("count")])
    .where("tenant_id", "=", tenantId)
    .groupBy("status")
    .execute();
}

/** Full attempt history for one job — tenant-scoped via a join, since
 * job_attempts has no tenant_id column of its own. */
export async function getJobAttempts(tenantId: string, jobId: string) {
  return db
    .selectFrom("job_attempts")
    .innerJoin("jobs", "jobs.id", "job_attempts.job_id")
    .select([
      "job_attempts.attempt_number",
      "job_attempts.worker_id",
      "job_attempts.outcome",
      "job_attempts.error_message",
      "job_attempts.started_at",
      "job_attempts.finished_at",
    ])
    .where("jobs.tenant_id", "=", tenantId)
    .where("job_attempts.job_id", "=", jobId)
    .orderBy("job_attempts.attempt_number", "asc")
    .execute();
}

/** The configured AI provider's triage result for a dead-lettered job, if
 * one exists yet — tenant-scoped the same way as getJobAttempts. */
export async function getTriageForJob(tenantId: string, jobId: string) {
  const row = await db
    .selectFrom("dead_letter_triage")
    .innerJoin("jobs", "jobs.id", "dead_letter_triage.job_id")
    .select([
      "dead_letter_triage.classification",
      "dead_letter_triage.suggested_fix",
      "dead_letter_triage.confidence",
      "dead_letter_triage.model_used",
      "dead_letter_triage.created_at",
    ])
    .where("jobs.tenant_id", "=", tenantId)
    .where("dead_letter_triage.job_id", "=", jobId)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Extend a job's lease without changing anything else about it. A worker
 * running a long task calls this periodically (e.g. every 10s while a
 * 5-minute job is still executing) so the sweeper never mistakes genuine,
 * in-progress work for a crashed worker. This is why the default 30s lease
 * in claimJob() is fine even for long jobs — the lease only has to be
 * longer than the gap between heartbeats, not longer than the whole job.
 *
 * Only renews if this exact worker still holds the job and it's still
 * running — if the lease already expired and the sweeper already reclaimed
 * it (possibly to another worker by now), this becomes a no-op instead of
 * clobbering whoever has it now.
 */
export async function renewLease(jobId: string, workerId: string, leaseSeconds = 30) {
  const result = await db
    .updateTable("jobs")
    .set({
      locked_until: sql`now() + make_interval(secs => ${leaseSeconds})`,
      updated_at: sql`now()`,
    })
    .where("id", "=", jobId)
    .where("locked_by", "=", workerId)
    .where("status", "=", "running")
    .executeTakeFirst();

  return result.numUpdatedRows > 0n;
}

/** Exponential backoff with full jitter, capped at 5 minutes. */
export function computeBackoffMs(attempt: number): number {
  const baseMs = 2_000;
  const maxMs = 5 * 60_000;
  const exp = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return Math.floor(exp * (0.5 + Math.random() * 0.5)); // 50%-100% of the exponential value
}

type ClaimedJob = Awaited<ReturnType<typeof claimJob>>;

export async function completeJob(job: NonNullable<ClaimedJob>, workerId: string) {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("jobs")
      .set({
        status: "completed" as JobStatus,
        completed_at: sql`now()`,
        locked_by: null,
        locked_until: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", job.id)
      .execute();

    await trx
      .insertInto("job_attempts")
      .values({
        job_id: job.id,
        attempt_number: job.attempts,
        worker_id: workerId,
        outcome: "success",
        finished_at: sql`now()`,
      })
      .execute();

    await recordAttemptStats(trx, job.tenant_id, job.job_type, job.attempts, "success");
  });
}

/**
 * Shared by failJob() and the lease sweeper: given a job that just failed
 * (however that was discovered), either requeue it with backoff or move it
 * to dead_letter if attempts are exhausted, and record the attempt.
 */
async function transitionFailedJob(
  trx: import("kysely").Transaction<import("./db.js").Database>,
  job: { id: string; tenant_id: string; job_type: string; attempts: number; max_attempts: number },
  workerId: string,
  errorMessage: string,
  errorStack: string | null = null
) {
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    await trx
      .updateTable("jobs")
      .set({
        status: "dead_letter" as JobStatus,
        locked_by: null,
        locked_until: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", job.id)
      .execute();
  } else {
    const backoffMs = await computeAdaptiveBackoffMs(trx, job.tenant_id, job.job_type, job.attempts);
    await trx
      .updateTable("jobs")
      .set({
        status: "pending" as JobStatus,
        run_after: sql`now() + make_interval(secs => ${Math.ceil(backoffMs / 1000)})`,
        locked_by: null,
        locked_until: null,
        updated_at: sql`now()`,
      })
      .where("id", "=", job.id)
      .execute();
  }

  await trx
    .insertInto("job_attempts")
    .values({
      job_id: job.id,
      attempt_number: job.attempts,
      worker_id: workerId,
      outcome: "failure",
      finished_at: sql`now()`,
      error_message: errorMessage,
      error_stack: errorStack,
    })
    .execute();

  await recordAttemptStats(trx, job.tenant_id, job.job_type, job.attempts, "failure");

  return { exhausted };
}

export async function failJob(
  job: NonNullable<ClaimedJob>,
  workerId: string,
  error: Error
) {
  const result = await db.transaction().execute((trx) =>
    transitionFailedJob(trx, job, workerId, error.message, error.stack ?? null)
  );

  // Fired only after the transaction has committed, and never awaited —
  // a slow or failing Claude call must never hold open the job's status
  // transition, which has already happened by this point.
  if (result.exhausted) triageDeadLetterJobInBackground(job.id);

  return result;
}

/**
 * Find jobs stuck in `running` whose lease (locked_until) has expired —
 * meaning the worker that claimed them never reported back, most likely
 * because it crashed, was killed, or lost network connectivity. Without
 * this, such a job would sit in `running` forever, invisible to every
 * other worker, since claimJob() only ever looks at `pending` rows.
 *
 * Uses the same FOR UPDATE SKIP LOCKED pattern as claimJob(), so multiple
 * sweeper instances (or a sweeper running alongside real workers) can
 * never double-process the same expired job.
 */
export async function sweepExpiredLeases(batchSize = 100) {
  let reclaimedToPending = 0;
  let movedToDeadLetter = 0;
  const deadLetteredJobIds: string[] = [];

  await db.transaction().execute(async (trx) => {
    const expired = await trx
      .selectFrom("jobs")
      .select(["id", "tenant_id", "job_type", "attempts", "max_attempts", "locked_by"])
      .where("status", "=", "running")
      .where(sql<boolean>`locked_until < now()`)
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();

    for (const job of expired) {
      const { exhausted } = await transitionFailedJob(
        trx,
        job,
        job.locked_by ?? "unknown-worker",
        "Lease expired: worker did not report completion before locked_until"
      );

      if (exhausted) {
        movedToDeadLetter++;
        deadLetteredJobIds.push(job.id);
      } else {
        reclaimedToPending++;
      }
    }
  });

  // Same rule as failJob(): only fire triage once the transaction has
  // actually committed, and never await it here — the sweep result below
  // must return promptly regardless of how long Claude takes to respond.
  for (const jobId of deadLetteredJobIds) {
    triageDeadLetterJobInBackground(jobId);
  }

  return { reclaimedToPending, movedToDeadLetter };
}

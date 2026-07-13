import "dotenv/config";
import { sql } from "kysely";
import { getDefaultTenantId } from "./tenant.js";
import { enqueue, claimJob, completeJob, failJob, sweepExpiredLeases } from "./queue.js";
import { db } from "./db.js";

async function main() {
  // Reset state so each run of this demo is independent and the output
  // isn't polluted by pending/dead_letter rows left over from previous runs.
  await sql`TRUNCATE jobs, job_attempts RESTART IDENTITY CASCADE`.execute(db);

  const tenantId = await getDefaultTenantId();

  console.log("\n--- Scenario 1: enqueue + claim + complete ---");
  const job1 = await enqueue(tenantId, "send_email", { to: "a@b.com" }, { maxAttempts: 3 });
  console.log("enqueued:", job1?.id, job1?.status);

  const claimed1 = await claimJob(tenantId, "worker-1");
  console.log("claimed:", claimed1?.id, "status:", claimed1?.status, "attempts:", claimed1?.attempts);

  if (claimed1) {
    await completeJob(claimed1, "worker-1");
    const after = await db.selectFrom("jobs").selectAll().where("id", "=", claimed1.id).executeTakeFirst();
    console.log("after complete:", after?.status);
  }

  console.log("\n--- Scenario 2: two workers race for the same job ---");
  const job2 = await enqueue(tenantId, "resize_image", { key: "img.png" }, { maxAttempts: 3 });
  console.log("enqueued:", job2?.id);

  const [claimA, claimB] = await Promise.all([
    claimJob(tenantId, "worker-A"),
    claimJob(tenantId, "worker-B"),
  ]);
  console.log("worker-A got:", claimA?.id ?? "nothing");
  console.log("worker-B got:", claimB?.id ?? "nothing");
  console.log("(exactly one of these should be job2's id, the other should be nothing/a different job)");

  console.log("\n--- Scenario 3: retry with backoff, then dead-letter ---");
  const job3 = await enqueue(tenantId, "flaky_job", { note: "always fails" }, { maxAttempts: 2 });
  console.log("enqueued:", job3?.id, "max_attempts:", job3?.max_attempts);

  for (let i = 0; i < 3; i++) {
    const claimed = await claimJob(tenantId, "worker-1", { jobTypes: ["flaky_job"] });
    if (!claimed) {
      console.log(`attempt ${i + 1}: nothing claimable yet (run_after is in the future)`);
      continue;
    }
    console.log(`attempt ${i + 1}: claimed, attempts=${claimed.attempts}`);
    const { exhausted } = await failJob(claimed, "worker-1", new Error("simulated failure"));
    const after = await db.selectFrom("jobs").selectAll().where("id", "=", claimed.id).executeTakeFirst();
    console.log(`  -> status now: ${after?.status}, run_after: ${after?.run_after}, exhausted: ${exhausted}`);
  }

  console.log("\n--- Scenario 4: dedupe key blocks a duplicate enqueue ---");
  const first = await enqueue(tenantId, "send_email", { to: "user@example.com" }, {
    dedupeKey: "welcome-email-user-42",
  });
  console.log("first enqueue:", first?.id, "status:", first?.status);

  const second = await enqueue(tenantId, "send_email", { to: "user@example.com" }, {
    dedupeKey: "welcome-email-user-42",
  });
  console.log("second enqueue (same dedupeKey):", second === null ? "null (rejected, no new row)" : second.id);

  const countWithKey = await db
    .selectFrom("jobs")
    .select(db.fn.countAll().as("count"))
    .where("dedupe_key", "=", "welcome-email-user-42")
    .executeTakeFirst();
  console.log("rows in DB with that dedupeKey:", countWithKey?.count);

  console.log("\n--- Scenario 5: worker crashes mid-job, sweeper reclaims it ---");
  const job5 = await enqueue(tenantId, "crash_test", { note: "worker dies before reporting" }, {
    maxAttempts: 3,
  });
  console.log("enqueued:", job5?.id, "max_attempts:", job5?.max_attempts);

  const claimed5 = await claimJob(tenantId, "worker-doomed", { jobTypes: ["crash_test"] });
  console.log("claimed by worker-doomed:", claimed5?.id, "attempts:", claimed5?.attempts);
  console.log("(worker-doomed now crashes silently — never calls completeJob or failJob)");

  // Simulate the crash: force the lease into the past, exactly what would
  // naturally happen once locked_until's real expiry (default 30s) passes.
  await db
    .updateTable("jobs")
    .set({ locked_until: sql`now() - interval '1 second'` })
    .where("id", "=", claimed5!.id)
    .execute();

  const otherWorkerAttempt = await claimJob(tenantId, "worker-2", { jobTypes: ["crash_test"] });
  console.log(
    "another worker polling right now gets:",
    otherWorkerAttempt?.id ?? "nothing",
    "(still 'running' as far as claimJob is concerned — it only looks at 'pending')"
  );

  const sweep1 = await sweepExpiredLeases();
  console.log("sweeper ran:", sweep1);

  const afterSweep = await db.selectFrom("jobs").selectAll().where("id", "=", claimed5!.id).executeTakeFirst();
  console.log("job status after sweep:", afterSweep?.status, "run_after:", afterSweep?.run_after);

  console.log("\n--- Scenario 6: crash on the last allowed attempt -> straight to dead_letter ---");
  const job6 = await enqueue(tenantId, "crash_test_once", { note: "only 1 attempt allowed" }, {
    maxAttempts: 1,
  });
  const claimed6 = await claimJob(tenantId, "worker-doomed-2", { jobTypes: ["crash_test_once"] });
  console.log("claimed:", claimed6?.id, "attempts:", claimed6?.attempts, "max_attempts:", claimed6?.max_attempts);

  await db
    .updateTable("jobs")
    .set({ locked_until: sql`now() - interval '1 second'` })
    .where("id", "=", claimed6!.id)
    .execute();

  const sweep2 = await sweepExpiredLeases();
  console.log("sweeper ran:", sweep2);

  const afterSweep2 = await db.selectFrom("jobs").selectAll().where("id", "=", claimed6!.id).executeTakeFirst();
  console.log("job status after sweep:", afterSweep2?.status, "(should be dead_letter, no attempts left)");

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "dotenv/config";
import { sql } from "kysely";
import { db } from "./db.js";
import { getDefaultTenantId } from "./tenant.js";
import { enqueue, claimJob, failJob, completeJob } from "./queue.js";

async function main() {
  await sql`TRUNCATE jobs, job_attempts, job_type_stats RESTART IDENTITY CASCADE`.execute(db);
  const tenantId = await getDefaultTenantId();

  console.log("--- Building up failure history for job type 'chronically_broken' (attempt 1) ---");
  // Simulate 10 separate jobs of this type all failing on attempt 1, to push
  // success rate at attempt 1 down toward 0% with enough samples to trust.
  for (let i = 0; i < 10; i++) {
    const job = await enqueue(tenantId, "chronically_broken", { i }, { maxAttempts: 5 });
    const claimed = await claimJob(tenantId, "worker-1", { jobTypes: ["chronically_broken"] });
    await failJob(claimed!, "worker-1", new Error("always fails"));
  }

  console.log("--- Building up success history for job type 'usually_fine' (attempt 1) ---");
  // Simulate 10 jobs of a different type mostly succeeding on attempt 1.
  for (let i = 0; i < 10; i++) {
    const job = await enqueue(tenantId, "usually_fine", { i }, { maxAttempts: 5 });
    const claimed = await claimJob(tenantId, "worker-1", { jobTypes: ["usually_fine"] });
    if (i < 9) {
      await completeJob(claimed!, "worker-1");
    } else {
      await failJob(claimed!, "worker-1", new Error("rare failure"));
    }
  }

  const stats = await db.selectFrom("job_type_stats").selectAll().execute();
  console.log("\njob_type_stats after building history:");
  for (const s of stats) {
    console.log(
      `  ${s.job_type} attempt=${s.attempt_number}: success=${s.success_count} failure=${s.failure_count}`
    );
  }

  // IMPORTANT: the loop above leaves behind pending, backed-off jobs (each
  // failure requeues rather than deletes). If we don't clear those out, the
  // "final" claim below could grab one of those leftover jobs instead of
  // the fresh one we just enqueued, silently invalidating the comparison.
  // job_type_stats is untouched by this — stats live independently of any
  // specific job row.
  await db.deleteFrom("jobs").where("job_type", "in", ["chronically_broken", "usually_fine"]).execute();

  console.log("\n--- Now compare backoff assigned on the NEXT failure of each type ---");

  const brokenJob = await enqueue(tenantId, "chronically_broken", { final: true }, { maxAttempts: 5 });
  const claimedBroken = await claimJob(tenantId, "worker-1", { jobTypes: ["chronically_broken"] });
  if (claimedBroken!.id !== brokenJob!.id) throw new Error("claimed the wrong job — test is invalid");
  await failJob(claimedBroken!, "worker-1", new Error("still broken"));
  const afterBroken = await db.selectFrom("jobs").selectAll().where("id", "=", claimedBroken!.id).executeTakeFirst();
  const brokenWaitMs = new Date(afterBroken!.run_after).getTime() - Date.now();
  console.log(`chronically_broken (low historical success rate) -> next retry in ~${brokenWaitMs}ms`);

  const fineJob = await enqueue(tenantId, "usually_fine", { final: true }, { maxAttempts: 5 });
  const claimedFine = await claimJob(tenantId, "worker-1", { jobTypes: ["usually_fine"] });
  if (claimedFine!.id !== fineJob!.id) throw new Error("claimed the wrong job — test is invalid");
  await failJob(claimedFine!, "worker-1", new Error("rare failure again"));
  const afterFine = await db.selectFrom("jobs").selectAll().where("id", "=", claimedFine!.id).executeTakeFirst();
  const fineWaitMs = new Date(afterFine!.run_after).getTime() - Date.now();
  console.log(`usually_fine (high historical success rate) -> next retry in ~${fineWaitMs}ms`);

  console.log(
    "\n(Both jobs are on their 2nd attempt, same static base backoff — the difference above is purely the adaptive scaling.)"
  );

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

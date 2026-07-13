import "dotenv/config";
import cron from "node-cron";
import { sweepExpiredLeases } from "./queue.js";

/**
 * Long-running scheduler process — runs sweepExpiredLeases() on a cron
 * expression forever, instead of being invoked externally by host cron or
 * a separate cron container. This is meant to be its own service in
 * docker-compose.yml (same image, different command), so self-hosting
 * needs no OS-level cron setup or extra tooling at all.
 *
 * sweepExpiredLeases() is idempotent and holds no state between runs, so
 * the exact schedule is a tuning knob, not a correctness concern — running
 * every 10s just notices crashed workers faster than every minute would.
 */
const SWEEP_SCHEDULE = process.env.SWEEP_CRON_SCHEDULE ?? "*/10 * * * * *";

console.log(`[sweeper] starting, schedule="${SWEEP_SCHEDULE}"`);

cron.schedule(SWEEP_SCHEDULE, async () => {
  try {
    const result = await sweepExpiredLeases();
    if (result.reclaimedToPending > 0 || result.movedToDeadLetter > 0) {
      console.log(
        `[sweeper] ${new Date().toISOString()} reclaimed=${result.reclaimedToPending} dead_lettered=${result.movedToDeadLetter}`
      );
    }
  } catch (err) {
    console.error("[sweeper] sweep failed:", err);
  }
});

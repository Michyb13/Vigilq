import { JobQueueClient } from "../src/client.js";

const client = new JobQueueClient({
  baseUrl: process.env.QUEUE_URL ?? "http://localhost:4000",
  apiKey: process.env.QUEUE_API_KEY ?? "",
});

async function main() {
  console.log("--- enqueue via SDK ---");
  const job = await client.enqueue("sdk_test_email", { to: "sdk-user@example.com" }, { maxAttempts: 2 });
  console.log("enqueued:", job?.id, job?.status);

  console.log("\n--- enqueue a job designed to fail once, then succeed ---");
  const flaky = await client.enqueue("sdk_flaky", { attempt: "will fail first time" }, { maxAttempts: 3 });
  console.log("enqueued flaky job:", flaky?.id);

  let flakyAttempts = 0;

  client.registerWorker<{ to: string }>("sdk_test_email", async (j) => {
    console.log(`[worker] processing sdk_test_email job ${j.id}, payload:`, j.payload);
  });

  client.registerWorker("sdk_flaky", async (j) => {
    flakyAttempts++;
    console.log(`[worker] sdk_flaky attempt #${flakyAttempts} for job ${j.id}`);
    if (flakyAttempts < 2) {
      throw new Error("simulated failure on first attempt");
    }
    console.log(`[worker] sdk_flaky succeeded on attempt #${flakyAttempts}`);
  });

  const workersPromise = client.startWorkers({ concurrency: 2, pollIntervalMs: 500 });

  // Let the workers run for a bit, then check final status and stop.
  await sleep(4000);

  const finalEmail = await client.getJobStatus(job!.id);
  console.log("\nfinal status of sdk_test_email job:", finalEmail?.status);

  const finalFlaky = await client.getJobStatus(flaky!.id);
  console.log("final status of sdk_flaky job:", finalFlaky?.status, "attempts:", finalFlaky?.attempts);

  await client.stop();
  await workersPromise;
  process.exit(0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

---
sidebar_position: 1
title: TypeScript
---

# TypeScript SDK

```bash
npm install vigilq-client
```

## Connect

```ts
import { JobQueueClient } from "vigilq-client";

const queue = new JobQueueClient({
  baseUrl: process.env.QUEUE_URL!,
  apiKey: process.env.QUEUE_API_KEY!,
});
```

## Enqueue a job

```ts
const job = await queue.enqueue("send_email", {
  to: "user@example.com",
  subject: "Welcome!",
}, {
  maxAttempts: 3,
  dedupeKey: `welcome-${userId}`, // optional — a second call with the same key is a safe no-op
  pool: "standard",               // optional — see Scaling & pools
});
```

Returns `null` if `dedupeKey` collided with an existing job — that's not an error, it just means the work is already queued.

## Process jobs

```ts
queue.registerWorker<{ to: string; subject: string }>("send_email", async (job) => {
  await sendEmail(job.payload);
  // throw here to trigger a retry with backoff, or dead-letter after maxAttempts
});

await queue.startWorkers({
  concurrency: 5,      // parallel poll loops in this process
  pollIntervalMs: 1000,
  pool: "standard",     // optional — only claim jobs tagged for this pool
});
```

`startWorkers()` runs forever until `queue.stop()` resolves it — it's meant to be the last line in a long-running worker process, not something you call from a request handler.

## Check a job's status

```ts
const job = await queue.getJobStatus(jobId);
job?.status; // "pending" | "running" | "completed" | "failed" | "dead_letter"
```

## Graceful shutdown

```ts
process.on("SIGTERM", async () => {
  await queue.stop(); // stops claiming new jobs, waits for in-flight ones to finish
  process.exit(0);
});
```

## Full API

| Method | Description |
|---|---|
| `enqueue(jobType, payload, opts?)` | Insert a job. `opts`: `pool`, `priority`, `maxAttempts`, `dedupeKey`, `runAfter`. |
| `getJobStatus(jobId)` | Fetch a job's current row, or `null` if not found. |
| `registerWorker(jobType, handler)` | Map a job type to a handler function. |
| `startWorkers(opts?)` | Start polling and processing registered job types. `opts`: `concurrency`, `pollIntervalMs`, `leaseSeconds`, `pool`. Blocks until stopped. |
| `stop()` | Stop claiming new jobs; resolves once in-flight jobs finish. |

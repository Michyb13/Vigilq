# vigilq-client

TypeScript client SDK for VigilQ — a self-hosted distributed job queue with automatic retries, exponential backoff, worker pools, and AI-powered dead-letter triage.

This package talks to a running VigilQ engine over HTTP. It doesn't run a queue itself — you'll need the engine running somewhere (Docker Compose or plain Node + Postgres) to point this at.

## Install

```bash
npm install vigilq-client
```

## Enqueue a job

```ts
import { JobQueueClient } from "vigilq-client";

const queue = new JobQueueClient({
  baseUrl: process.env.QUEUE_URL!,   // e.g. http://localhost:4000
  apiKey: process.env.QUEUE_API_KEY!,
});

await queue.enqueue("send_welcome_email", { userId: "usr_123", email: "a@b.com" }, {
  maxAttempts: 3,
  dedupeKey: "welcome-usr_123", // optional — prevents duplicate enqueues
});
```

## Run a worker

```ts
queue.registerWorker("send_welcome_email", async (job) => {
  await sendEmail(job.payload);
  // throw here to trigger a retry with backoff, or dead-letter after maxAttempts
});

await queue.startWorkers({
  concurrency: 5,       // parallel poll loops in this process
  pollIntervalMs: 1000,
  pool: "standard",     // optional — only claims jobs tagged for this pool
});
```

`startWorkers()` runs forever (until `queue.stop()` resolves it) — it's meant to be the last line in a long-running worker process, not called from a request handler.

## Check a job's status

```ts
const job = await queue.getJobStatus(jobId);
console.log(job?.status); // "pending" | "running" | "completed" | "failed" | "dead_letter"
```

## API

| Method | Description |
|---|---|
| `enqueue(jobType, payload, opts?)` | Insert a job. Returns `null` if `dedupeKey` collided with an existing one. |
| `getJobStatus(jobId)` | Fetch a job's current row, or `null` if not found. |
| `registerWorker(jobType, handler)` | Map a job type to a handler function. |
| `startWorkers(opts?)` | Start polling and processing registered job types. Blocks until stopped. |
| `stop()` | Stop claiming new jobs; resolves once in-flight jobs finish. |

The VigilQ project also includes the engine itself, a monitoring dashboard, and C#/Python client SDKs — this package is just the TypeScript client.

## License

MIT

---
sidebar_position: 1
title: Local development vs. production
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Local development vs. production

The short version: **the same `docker-compose.yml` and the same worker code run in both places — only `.env` changes.** This page walks through that concretely with two real job types, `send_email` and `resize_image`, then covers every genuine difference worth being deliberate about before you actually deploy.

## The worker (identical in both environments)

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```ts
// worker/index.ts
import { JobQueueClient } from "vigilq-client";
import { sendEmail } from "./email-provider";
import sharp from "sharp";
import { downloadFromBucket, uploadToBucket } from "./storage";

const queue = new JobQueueClient({
  baseUrl: process.env.QUEUE_URL!,
  apiKey: process.env.QUEUE_API_KEY!,
});

queue.registerWorker<{ to: string; subject: string; body: string }>("send_email", async (job) => {
  await sendEmail(job.payload);
});

queue.registerWorker<{ bucket: string; key: string; width: number; height: number }>(
  "resize_image",
  async (job) => {
    const { bucket, key, width, height } = job.payload;
    const original = await downloadFromBucket(bucket, key);
    const resized = await sharp(original).resize(width, height).toBuffer();
    await uploadToBucket(bucket, `resized/${key}`, resized);
  }
);

await queue.startWorkers({ concurrency: 5, pollIntervalMs: 1000 });
```

</TabItem>
<TabItem value="csharp" label="C#">

```csharp
// Worker/Program.cs
using VigilQClient;

var queue = new JobQueueClient(
    Environment.GetEnvironmentVariable("QUEUE_URL")!,
    Environment.GetEnvironmentVariable("QUEUE_API_KEY")!
);

queue.RegisterWorker<EmailPayload>("send_email", async (job) =>
{
    await EmailProvider.SendAsync(job.Payload);
});

queue.RegisterWorker<ResizePayload>("resize_image", async (job) =>
{
    var original = await Storage.DownloadAsync(job.Payload.Bucket, job.Payload.Key);
    var resized = await ImageProcessor.ResizeAsync(original, job.Payload.Width, job.Payload.Height);
    await Storage.UploadAsync(job.Payload.Bucket, $"resized/{job.Payload.Key}", resized);
});

await queue.StartWorkersAsync(new StartWorkersOptions { Concurrency = 5, PollIntervalMs = 1000 });
```

</TabItem>
<TabItem value="python" label="Python">

```python
# worker/main.py
import os
from vigilq_client import JobQueueClient
from email_provider import send_email
from storage import download_from_bucket, upload_to_bucket
from PIL import Image
import io

queue = JobQueueClient(os.environ["QUEUE_URL"], os.environ["QUEUE_API_KEY"])

def handle_send_email(job):
    send_email(job.payload)

def handle_resize_image(job):
    bucket, key = job.payload["bucket"], job.payload["key"]
    width, height = job.payload["width"], job.payload["height"]
    original = download_from_bucket(bucket, key)
    image = Image.open(io.BytesIO(original)).resize((width, height))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    upload_to_bucket(bucket, f"resized/{key}", buf.getvalue())

queue.register_worker("send_email", handle_send_email)
queue.register_worker("resize_image", handle_resize_image)
queue.start_workers(concurrency=5, poll_interval_ms=1000)
```

</TabItem>
</Tabs>

## Add it to `docker-compose.yml` (also identical in both environments)

```yaml
services:
  # engine, sweeper, db from the quick start

  worker:
    build: ./worker
    environment:
      - QUEUE_URL=http://engine:4000     # Docker network hostname — same value locally and in prod
      - QUEUE_API_KEY=${QUEUE_API_KEY}
    deploy:
      replicas: 2
    depends_on:
      - engine
```

## Your app enqueues from wherever the real trigger happens (identical too)

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```ts
// after creating a user
await queue.enqueue("send_email", {
  to: user.email, subject: "Welcome!", body: "Thanks for signing up.",
}, { maxAttempts: 3, dedupeKey: `welcome-${user.id}` });

// after a file lands in storage
await queue.enqueue("resize_image", {
  bucket: "uploads", key: file.key, width: 800, height: 600,
}, { maxAttempts: 5 });
```

</TabItem>
<TabItem value="csharp" label="C#">

```csharp
// after creating a user
await queue.EnqueueAsync("send_email", new { to = user.Email, subject = "Welcome!", body = "Thanks for signing up." },
    new EnqueueOptions { MaxAttempts = 3, DedupeKey = $"welcome-{user.Id}" });

// after a file lands in storage
await queue.EnqueueAsync("resize_image", new { bucket = "uploads", key = file.Key, width = 800, height = 600 },
    new EnqueueOptions { MaxAttempts = 5 });
```

</TabItem>
<TabItem value="python" label="Python">

```python
# after creating a user
queue.enqueue("send_email", {
    "to": user.email, "subject": "Welcome!", "body": "Thanks for signing up.",
}, max_attempts=3, dedupe_key=f"welcome-{user.id}")

# after a file lands in storage
queue.enqueue("resize_image", {
    "bucket": "uploads", "key": file.key, "width": 800, "height": 600,
}, max_attempts=5)
```

</TabItem>
</Tabs>

## Testing it locally

```bash
docker compose up -d
# trigger your app's real signup/upload flow
open http://localhost:4000/dashboard/
```

Watch the job move `pending` → `running` → `completed` on the Jobs page. If `resize_image` throws, watch it retry with backoff, and check the Dead Letter page if it exhausts its attempts.

## Pushing to production

Copy the same `docker-compose.yml` and `worker/` code to your server (or your CI/CD deploy step), then:

```bash
cp .env.example .env
# edit .env: real production DATABASE_URL, real AI provider key if you want triage
docker compose up -d --build
```

The worker code, the job types, the `enqueue()` calls, and the compose file's shape are the same file, unchanged, in both places. The rest of this page covers what's genuinely different — and what's easy to overlook — about running this for real.

### 1. Rotate the API key rather than reusing your dev one

Don't copy the key your local dev instance printed on first boot into production. Let production mint its own on its own first boot, or rotate deliberately if you need to move a key from one place to another. Treat it exactly like a database password — something that lives in a secrets manager or your deploy pipeline's secret store, never in a file that gets committed.

### 2. `QUEUE_URL` only changes if the worker and engine are on different hosts

If everything's in one `docker-compose.yml` on one server, `http://engine:4000` is correct, unchanged, in production. It only becomes a real domain or IP address if your worker is deployed somewhere separate from wherever the engine runs — e.g. the engine on one VM and a worker fleet on another, or a worker running as a serverless function calling out to a centrally-hosted engine.

### 3. Put a reverse proxy in front for TLS

The engine serves plain HTTP — there's no built-in TLS termination. In production, put Caddy, nginx, or your cloud provider's load balancer in front of it to handle HTTPS, and point that at the engine's container over plain HTTP internally. This matters more the moment any traffic to the engine (SDK calls, dashboard access) crosses a network you don't fully control.

### 4. Decide who can reach the dashboard

Locally, `http://localhost:4000/dashboard/` being wide open is a non-issue — it's your own machine. In production, decide deliberately:

- Put it behind the same reverse proxy, gated by basic auth or your existing SSO, or
- Don't expose port 4000 publicly at all — put the engine on an internal/VPN-only network and access the dashboard by tunneling in, or
- Accept that anyone with the queue API key can already do anything the dashboard can do via the raw API, so the dashboard itself isn't a bigger attack surface than the API already is — but the API key itself absolutely needs the same secrecy as any other production credential.

### 5. Add restart policies

Locally, a crashed container just sits there until you notice and restart it by hand — fine for development. In production, add a restart policy so a transient crash (an OOM kill, a brief network blip) recovers on its own:

```yaml
engine:
  restart: unless-stopped
sweeper:
  restart: unless-stopped
worker:
  restart: unless-stopped
```

### 6. Back up the database

If you're using the bundled Postgres container, its data lives in a named Docker volume (`vigilq_pgdata`) on whatever host is running it — that volume is not automatically backed up anywhere. Set up a real backup strategy (a scheduled `pg_dump`, your cloud provider's volume snapshotting, or simplest of all, just use a managed Postgres instance in production instead of the bundled container, which typically handles backups for you).

### 7. Point `/health` at your monitoring

`GET /health` needs no auth and returns `{ "status": "ok" }` — wire it into whatever uptime/monitoring tool you already use (a simple HTTP check on an interval) so you find out the engine's down before your users do, rather than after.

### 8. Log aggregation

Locally, `docker compose logs -f` in a terminal is enough. In production, ship those logs somewhere durable and searchable (your cloud provider's logging service, or a self-hosted stack like Loki) — container logs that only exist inside a container's own buffer are lost the moment that container is recreated, which is exactly when you're most likely to want to know what happened.

### What genuinely never changes

- The worker's code, job types, and handler logic.
- The shape of `docker-compose.yml` (service names, how they're wired together).
- The SDK calls your app makes (`enqueue`, `registerWorker`, `startWorkers`).
- The database schema and how the engine talks to Postgres.

Everything that differs is either an environment variable in `.env`, or an operational concern (TLS, backups, monitoring, restart policy) that sits *around* Vigilq rather than inside it.

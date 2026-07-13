---
slug: /
sidebar_position: 1
title: VigilQ
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# VigilQ

VigilQ is a self-hosted distributed job queue: reliable retries with exponential backoff, worker pools for different hardware tiers, an optional autoscaler, and AI-powered triage on jobs that end up dead-lettered.

This page gets you from zero to your first job running, with no pools, no autoscaling, no configuration beyond a database connection string. Everything else in these docs is optional — add it if and when you actually need it.

## 1. Get the compose file and env template

```bash
mkdir my-project && cd my-project
curl -O https://raw.githubusercontent.com/vigilq/vigilq/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/vigilq/vigilq/main/.env.example
cp .env.example .env
```

## 2. Point it at a database

Open `.env` and set `DATABASE_URL`. Two options:

- **Don't have a Postgres instance handy?** Leave `DATABASE_URL` pointed at `db:5432` (the default) and run with the bundled-database profile in the next step.
- **Already have a Postgres instance** (local, RDS, Supabase, whatever)? Point `DATABASE_URL` at it directly and skip the bundled database entirely.

AI triage is optional too — leave `AI_PROVIDER`/the provider keys blank to skip it for now. See [AI triage providers](/reference/environment-variables#ai-triage-provider) when you're ready to turn it on.

## 3. Start it

```bash
# with the bundled Postgres:
docker compose --profile bundled-db up -d

# or, pointed at your own Postgres:
docker compose up -d
```

## 4. Get your API key

Printed once to the logs on first boot:

```bash
docker compose logs engine | grep "API key"
```

It's also saved inside the engine's data volume if you miss it — see [API keys](/reference/environment-variables#api-keys) for recovery.

## 5. Open the dashboard

```
http://localhost:4000/dashboard/
```

Paste in the key from step 4. You'll land on the Overview page — empty for now, since nothing's been enqueued yet.

## 6. Enqueue your first job

Install a client SDK in whatever app or script will trigger the work:

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```bash
npm install vigilq-client
```

```ts
import { JobQueueClient } from "vigilq-client";

const queue = new JobQueueClient({
  baseUrl: "http://localhost:4000",
  apiKey: "qk_live_...", // from step 4
});

await queue.enqueue("say_hello", { name: "World" });
```

</TabItem>
<TabItem value="csharp" label="C#">

```bash
dotnet add package VigilQ.Client
```

```csharp
using VigilQClient;

var queue = new JobQueueClient("http://localhost:4000", "qk_live_..."); // key from step 4

await queue.EnqueueAsync("say_hello", new { name = "World" });
```

</TabItem>
<TabItem value="python" label="Python">

```bash
pip install vigilq-client
```

```python
from vigilq_client import JobQueueClient

queue = JobQueueClient("http://localhost:4000", "qk_live_...")  # key from step 4

queue.enqueue("say_hello", {"name": "World"})
```

</TabItem>
</Tabs>

## 7. Run a worker to actually process it

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```ts
queue.registerWorker("say_hello", async (job) => {
  console.log(`Hello, ${job.payload.name}!`);
});

await queue.startWorkers({ concurrency: 5 });
```

</TabItem>
<TabItem value="csharp" label="C#">

```csharp
queue.RegisterWorker<HelloPayload>("say_hello", async (job) =>
{
    Console.WriteLine($"Hello, {job.Payload.Name}!");
});

await queue.StartWorkersAsync(new StartWorkersOptions { Concurrency = 5 });
```

</TabItem>
<TabItem value="python" label="Python">

```python
def handle_say_hello(job):
    print(f"Hello, {job.payload['name']}!")

queue.register_worker("say_hello", handle_say_hello)
queue.start_workers(concurrency=5)
```

</TabItem>
</Tabs>

Run this file, then refresh the dashboard's Jobs page — you'll see the job move from `pending` to `running` to `completed`.

## Where to go next

- **[Local development vs. production](/guides/local-vs-production)** — a full example with two real job types, showing exactly what changes (and, mostly, what doesn't) between testing on your laptop and deploying for real.
- **[SDKs](/sdks/typescript)** — the same three calls (`enqueue`, `registerWorker`, `startWorkers`) in TypeScript, C#, and Python.
- **[Advanced setup](/advanced/pools)** — worker pools and autoscaling, only relevant once you need different hardware tiers for different job types, or automatic replica scaling. Most projects never need this page.
- **[Reference](/reference/environment-variables)** — every environment variable, the full REST API, and what the dashboard shows.

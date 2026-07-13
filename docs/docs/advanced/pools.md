---
sidebar_position: 1
title: Worker pools
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Worker pools

Everything on this page is optional. If one worker process handling everything is enough for your project, skip this entirely — the [quick start](/) already covers that case completely, and most projects never need to come back to this page.

## The one thing a pool is for

A pool exists to answer exactly one question: **"which category of worker is allowed to claim this job?"** That's it. It has no other job, and it's easy to load more meaning onto it than it actually carries — so let's be precise before anything else.

### A pool is a label, not compute

A pool doesn't grant, define, or contain any RAM, CPU, or GPU. It's a string. The actual compute a worker has access to is provisioned entirely separately, in Docker — resource limits, replica count, GPU passthrough. The pool name only becomes *associated* with real hardware because you deploy a worker with matching Docker resource settings **and** give it that pool name. Delete the resource limits and GPU config from a `gpu-large` worker and it still correctly receives `gpu-large`-tagged jobs — it just no longer has the hardware to run them well. Nothing about that mismatch is detected or prevented by the queue.

### `job_type` vs. `pool` — these are not the same axis

| | `job_type` | `pool` |
|---|---|---|
| Set at enqueue time? | Yes, required | Yes, optional |
| Set at worker startup? | Implicitly, via which handlers are registered | Yes, optional |
| Controls | Which handler function runs | Which category of worker is allowed to claim it |
| Required? | Always | Never |

A worker only ever asks for the job types it has registered handlers for — so `job_type` alone already prevents a `send_email` worker from ever touching a `resize_image` job, with or without pools involved at all. Pool only starts mattering once **the same `job_type`** needs to run on two different hardware tiers — see the worked example below.

## Enqueue-side: tagging a job with a pool

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```ts
await queue.enqueue("resize_image", payload, {
  pool: needsAIUpscale ? "gpu-large" : "standard",
});
```

</TabItem>
<TabItem value="csharp" label="C#">

```csharp
await queue.EnqueueAsync("resize_image", payload, new EnqueueOptions
{
    Pool = needsAIUpscale ? "gpu-large" : "standard",
});
```

</TabItem>
<TabItem value="python" label="Python">

```python
queue.enqueue("resize_image", payload,
    pool="gpu-large" if needs_ai_upscale else "standard",
)
```

</TabItem>
</Tabs>

This part is fully supported and identical in behavior across all three SDKs.

## Worker-side: declaring which pool a process belongs to

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```ts
queue.registerWorker("resize_image", handleResize);
await queue.startWorkers({ pool: "gpu-large" });
```

</TabItem>
<TabItem value="csharp" label="C#">

```csharp
queue.RegisterWorker<ResizePayload>("resize_image", HandleResize);
await queue.StartWorkersAsync(new StartWorkersOptions { /* Concurrency, etc. */ });
```

:::caution Not supported yet
The C# SDK does not currently expose a `Pool` option on `StartWorkersOptions`. A C# worker will claim from **any** pool regardless of what's configured — see the wildcard behavior below. This is a known gap, not a deliberate design choice; if you need real pool-scoped workers today, use the TypeScript SDK for that specific worker process.
:::

</TabItem>
<TabItem value="python" label="Python">

```python
queue.register_worker("resize_image", handle_resize)
queue.start_workers(concurrency=5)
```

:::caution Not supported yet
The Python SDK does not currently accept a `pool` argument on `start_workers()`. A Python worker will claim from **any** pool regardless of what's configured — see the wildcard behavior below. This is a known gap, not a deliberate design choice; if you need real pool-scoped workers today, use the TypeScript SDK for that specific worker process.
:::

</TabItem>
</Tabs>

## The wildcard gotcha — the one nuance most worth internalizing

The claim query's actual filter, when a worker specifies a pool, is:

```sql
WHERE (pool = $workerPool OR pool IS NULL)
```

So a worker with a pool set claims jobs tagged for that pool **and** untagged jobs. But if a worker's pool is left completely unset, **no pool filter is applied at all** — that worker can claim absolutely any pending job, tagged or not, regardless of what pool it names. This is not symmetrical with "unassigned jobs," and it's easy to assume it is.

**Concretely, what goes wrong if you get this backwards:** you introduce a `gpu-large` pool for AI-upscale jobs on expensive hardware. You already have three "plain" workers running with no pool configured, left over from before pools existed. Those three plain workers are now perfectly willing to claim a `gpu-large` job and attempt it on hardware that can't handle it — nothing errors, nothing warns you, the job just runs badly or times out on inadequate hardware.

**The fix**: the moment you introduce even one named pool, give every worker an explicit pool — including your "regular" ones (e.g. `standard`) — so none of them are accidentally wildcards.

## Provisioning the actual compute, in Docker

None of this is required for pool *routing* to work — it's how you make the label mean something in terms of real hardware.

```yaml
worker-standard:
  build: ./worker
  environment:
    - WORKER_POOL=standard
  deploy:
    replicas: 3
    resources:
      limits: { memory: 256M, cpus: "0.5" }   # optional — omit for no cap at all

worker-gpu-large:
  build: ./worker
  environment:
    - WORKER_POOL=gpu-large
  runtime: nvidia                              # required if the container needs real GPU access
  deploy:
    replicas: 1
    resources:
      limits: { memory: 16G, cpus: "4" }
```

Your worker process reads `WORKER_POOL` and passes it into `startWorkers({ pool })` — that env var read is the only line connecting Docker's config to the queue's routing:

```ts
const pool = process.env.WORKER_POOL;
await queue.startWorkers({ pool });
```

### What `deploy:` actually does (and doesn't) outside Swarm mode

`deploy:` historically only meant anything under `docker stack deploy` (Docker Swarm). Modern `docker compose up` (the CLI built into Docker today) supports a **subset** of it without Swarm:

- **`deploy.resources.limits`** (memory/cpus) — works with no caveats.
- **`deploy.replicas`** — works, with one caveat: a service can't set `replicas > 1` **and** publish a fixed host port (`ports: ["4000:4000"]`) at the same time, since multiple containers can't all bind the same host port. Worker services never need a `ports:` mapping at all (they only make outbound calls to the engine), so this caveat never actually applies to a worker pool — it would only matter if you tried to add `replicas` to something like the engine service itself.
- Genuinely Swarm-only fields (`placement`, rolling-update configs) are silently ignored outside Swarm — not an error, just a no-op.

`deploy.replicas` is also just a **starting number**, not a persistent source of truth — see [Autoscaling](/advanced/autoscaling) for what happens to it once the autoscaler is involved.

## Full worked example: two pools, one job type

The concrete case where a second pool earns its keep — `resize_image` gains an AI-upscaling mode that needs a GPU, alongside plain resizes that don't:

<Tabs groupId="language">
<TabItem value="ts" label="TypeScript" default>

```ts
// two separate worker processes/containers, same job_type, different pools
await queue.startWorkers({ pool: "standard" });    // plain resize handler
await queue.startWorkers({ pool: "gpu-large" });    // AI-upscale handler, separate process
```

</TabItem>
<TabItem value="csharp" label="C#">

```csharp
// Pool-scoped workers aren't wired up in the C# SDK yet — see the caution above.
// Both processes would currently claim from any pool.
await queue.StartWorkersAsync();
```

</TabItem>
<TabItem value="python" label="Python">

```python
# Pool-scoped workers aren't wired up in the Python SDK yet — see the caution above.
# Both processes would currently claim from any pool.
queue.start_workers()
```

</TabItem>
</Tabs>

```yaml
# docker-compose.yml
worker-images-standard:
  build: ./worker
  command: ["node", "dist/image-worker.js", "--pool=standard"]
  deploy:
    replicas: 3
    resources: { limits: { memory: 256M, cpus: "0.5" } }

worker-images-gpu:
  build: ./worker
  command: ["node", "dist/image-worker.js", "--pool=gpu-large"]
  runtime: nvidia
  deploy:
    replicas: 1
    resources: { limits: { memory: 16G, cpus: "4" } }
```

## Common mistakes

- **Forgot `WORKER_POOL` on one worker service.** That worker becomes a silent wildcard — see the gotcha above. Nothing errors; it just starts claiming jobs it shouldn't.
- **Spelled the pool name differently in two places** (`gpu-large` vs `gpu_large`, or a typo). No error anywhere — the job simply never gets claimed by the worker you intended, and sits in `pending` forever, since nothing considers the mismatch worth flagging.
- **Tagged a job with a pool that no running worker has declared.** Same failure mode as above — the job is valid, enqueued correctly, and will sit in `pending` indefinitely until a matching worker actually exists and polls.
- **Assuming pool implies resource limits.** It doesn't — see "a pool is a label, not compute" above. Naming a pool `gpu-large` does nothing on its own; the Docker config is a separate, unenforced convention.

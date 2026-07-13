---
sidebar_position: 2
title: Autoscaling
---

# Autoscaling

Optional, and layered entirely on top of [worker pools](/advanced/pools) — read that page first if you haven't. Autoscaling only ever changes **how many** workers exist in a pool; it has no effect on pool *routing*, resource limits, or GPU access, all of which are decided elsewhere.

## Do you need this at all?

If your load is steady and predictable, a fixed `deploy.replicas` count is simpler, cheaper to reason about, and has one less moving part to debug. Autoscaling earns its complexity when load is genuinely bursty — a pool that's sometimes idle and sometimes backed up 50-deep — and you don't want to either over-provision for the peak or manually watch a dashboard and run `docker compose up --scale` by hand.

## What it actually is

A separate, standalone service — not part of the engine, not part of the dashboard. It does exactly three things, forever, on a timer:

1. Poll `GET /pools/depths` on the engine.
2. Decide, per pool, whether the replica count should change.
3. If it should, run `docker compose up -d --scale <service>=<N>`.

It never touches Postgres directly, never talks to workers directly, and never changes anything about which jobs go to which pool.

## The decision, precisely

The core logic is a pure function — given the current state, it returns the next replica count, with no side effects of its own:

```ts
function computeDesiredReplicas({ pendingCount, currentReplicas, idleMinutes, config }) {
  const { minWorkers, maxWorkers, scaleUpThreshold, scaleDownIdleMinutes } = config;

  if (pendingCount >= scaleUpThreshold && currentReplicas < maxWorkers) {
    return currentReplicas + 1;
  }

  if (pendingCount === 0 && idleMinutes >= scaleDownIdleMinutes && currentReplicas > minWorkers) {
    return currentReplicas - 1;
  }

  // no change warranted, but always clamp to current bounds
  return Math.min(Math.max(currentReplicas, minWorkers), maxWorkers);
}
```

Three properties of this worth understanding, not just the code:

- **It scales by exactly one replica per tick, in either direction.** It never jumps straight to a computed "ideal" replica count based on one depth reading. This is deliberate — jumping to a big number based on a single snapshot is exactly how autoscalers start flapping: scale to 8 because the queue is deep, the queue drains because those 8 workers are now running, scale back down to 1, repeat forever.
- **Scale-up is checked before scale-down**, so a pathological state (somehow both conditions true at once) always resolves toward adding capacity, never removing it.
- **It always clamps to `[minWorkers, maxWorkers]`**, even on ticks where no scaling decision was made — so if you edit the config and lower `maxWorkers` below the current replica count, the very next tick corrects it, rather than waiting for a scale-up/down trigger that might never come.

## `pools.config.yaml` — full schema

```yaml
engineUrl: http://engine:4000        # required — where the autoscaler polls queue depth
apiKey: ${QUEUE_API_KEY}              # required — needs a real queue API key to call the engine
composeFile: ./docker-compose.yml    # required — which compose file to run --scale against
pollIntervalSeconds: 30              # how often it ticks

pools:
  standard:
    dockerService: worker-images-standard  # must match the service name in docker-compose.yml exactly
    minWorkers: 1          # floor — never scales below this, even at zero load
    maxWorkers: 6          # ceiling — never scales above this regardless of demand
    scaleUpThreshold: 10   # pending jobs in this pool before adding a replica
    scaleDownIdleMinutes: 5  # consecutive minutes at zero pending before removing a replica

  gpu-large:
    dockerService: worker-images-gpu
    minWorkers: 0          # fine to scale to zero — an expensive pool with no idle cost
    maxWorkers: 3
    scaleUpThreshold: 3    # a lower threshold — GPU jobs are individually more expensive to leave waiting
    scaleDownIdleMinutes: 10  # a longer idle window — avoids tearing down and rebuilding GPU workers too eagerly
```

**A pool with no entry here is simply never touched by the autoscaler at all** — no error, no warning, it's just outside the autoscaler's awareness. This is exactly how you'd leave a steady, low-traffic pool (like a `send_email` worker) on a fixed replica count while only autoscaling the bursty ones.

## `minWorkers` / `maxWorkers` vs. `deploy.replicas` — these are not the same thing

Docker Compose itself only ever has one number, `deploy.replicas`, and no min/max concept at all. Once the autoscaler starts running, its `--scale` command-line flag **overrides** whatever `deploy.replicas` says in the compose file, every single tick it runs. So `deploy.replicas: 1` in your compose file is really only the count that exists **before the autoscaler has run even once** — from that point on, the autoscaler's own `minWorkers`/`maxWorkers` bounds are what actually govern the range, and the compose file's `replicas` value is closer to a historical starting point than a live source of truth.

## Wiring it into `docker-compose.yml`

```yaml
autoscaler:
  build: ./autoscaler
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock   # required — this is how it runs `docker compose --scale`
    - ./docker-compose.yml:/app/docker-compose.yml:ro
    - ./pools.config.yaml:/app/pools.config.yaml:ro
```

## Testing it

```bash
docker compose up -d
# enqueue a burst — e.g. a script calling enqueue("resize_image", ...) 30 times quickly, all pool: "standard"
docker compose logs -f autoscaler
```

You should see log lines like:
```
[autoscaler] standard: pending=14 current=1 -> scaling to 2
```

Confirm the replica count actually changed:
```bash
docker compose ps worker-images-standard
```

**Scale-down is intentionally slow to observe** — it waits the full `scaleDownIdleMinutes` of the pool sitting at zero pending jobs before removing a single replica. Don't expect it to shrink back down immediately after a burst clears; that delay is the point, since it avoids tearing a worker down moments before the next burst of jobs arrives.

## The Docker socket — a real trust boundary, not a config detail

Mounting `/var/run/docker.sock` into the autoscaler container gives it control over **every container on that host**, not just the specific worker services listed in `pools.config.yaml`. This is worth treating deliberately rather than glossing over:

- Don't run untrusted code anywhere on the same host as the autoscaler.
- Treat the autoscaler's own image/build process with the same scrutiny you'd give the engine itself — a compromised autoscaler container is a compromised host.
- If your infrastructure has a notion of least-privilege hosts, the autoscaler is a strong candidate for its own dedicated, minimal host rather than sharing one with unrelated services.

## What autoscaling explicitly does not do

- It doesn't change which pool a job is routed to — that's fixed at enqueue time and worker-registration time, entirely independent of replica count.
- It doesn't change a worker's resource limits or GPU access — those are set once, in `docker-compose.yml`, and stay fixed regardless of replica count.
- It doesn't provision brand-new hardware or hosts — it only starts/stops containers on infrastructure that already exists and is already reachable by the host running `docker compose`.

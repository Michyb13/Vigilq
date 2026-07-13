# Vigilq — Project Plan

*A self-hosted distributed job queue.*

## What this is

A distributed job queue with workers, exponential backoff/retry, dead-letter
handling, and an AI twist.

**Primary goal: self-hosted, via Docker, used through the SDKs.** Someone
runs `docker-compose up`, gets Postgres + the engine running locally, and
integrates it into their own app using one of the 4 client SDKs (TS, C#,
Python, Java). This is the thing that needs to actually be good.

**SaaS is a secondary, later goal** — only worth building out (billing,
managed Claude key, tenant signup flow) if the self-hosted tool gets real
adoption. The schema supports multi-tenancy from day one (see below) so
that door stays open cheaply, but no SaaS-specific work happens until
there's a reason to.

The core idea either way: **one engine, many thin clients.** All the hard
distributed-systems logic (claiming, leases, backoff, DLQ) lives in a single
codebase. Every language binding is just an HTTP client + polling loop — no
duplicated queue logic, no drift between implementations.

## AI twist

1. **AI failure triage** — when a job exhausts all retries and lands in the
   dead-letter queue, Claude reads the error message + job/attempt history and
   classifies the root cause (transient network error vs. bad payload vs.
   code bug), then suggests a fix. Runs async, never blocks the retry path.
2. **Adaptive retry policy** — instead of a fixed backoff curve, track
   success/failure stats per job type bucketed by attempt number, and use
   that history (simple bandit / EWMA-tuned backoff) to adjust retry timing
   and max-attempt limits per job type automatically.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Engine | TypeScript (Node) | Reference implementation (BullMQ) to learn from; unifies with Next.js frontend |
| Durable store | PostgreSQL | `SELECT ... FOR UPDATE SKIP LOCKED` gives safe concurrent claiming without a separate broker; durable + queryable job table for free |
| AI | Anthropic API (Claude) | Failure triage on dead-lettered jobs |
| Frontend | Next.js | Dashboard: job states, metrics, DLQ inspection, triage results |
| Client SDKs | TypeScript, C#, Python, Java | Thin wrappers around the engine's REST API — no queue logic duplicated |

## Core job-queue components (the theory, mapped to implementation)

Using AWS SQS as the mental model:

1. **The mailbox (durable store)** — Postgres table, one row per job, with a
   `status` column (`pending` / `running` / `done` / `failed` / `dead_letter`).
2. **Claiming without collisions** — `SELECT ... FOR UPDATE SKIP LOCKED` so
   concurrent workers never grab the same row.
3. **Leases / heartbeats** — `locked_until` timestamp set on claim (default
   30s); a background sweeper requeues jobs whose lease expired without
   completion (handles crashed workers). A flat lease doesn't mean jobs
   must finish within it: a worker running a long task calls `renewLease()`
   periodically (e.g. every 10s) to push `locked_until` forward while still
   working, so the lease only has to outlast the gap between heartbeats,
   not the whole job. The sweeper itself runs as a long-lived scheduler
   process (`node-cron` inside the engine image, its own container/command
   in `docker-compose.yml`) firing every ~10s — not host crontab or a
   separate cron tool, since `node-cron` supports sub-minute schedules that
   plain OS cron can't do, and it needs zero extra self-host setup.
4. **Retry + exponential backoff with jitter** — failed attempts wait
   progressively longer (e.g. 2s, 4s, 8s...) plus randomized jitter to avoid
   thundering-herd retries.
5. **Dead-letter queue (DLQ)** — after N attempts, job moves to
   `dead_letter` status instead of retrying forever. This is where AI triage
   plugs in.
6. **Idempotency** — dedupe key per job so at-least-once delivery semantics
   never cause double-processing.

## Workers

A worker is a long-running process that loops: **claim a job → run user code
against it → report success/failure → repeat.** The engine has no idea what
a job actually *does* — it only stores `job_type` + a JSON `payload`. The
worker is what maps `job_type` to real code, via a registered handler:

```ts
queue.registerWorker("send_email", async (job) => {
  await sendEmail(job.payload.to, job.payload.subject, job.payload.body);
  // resolve = success. throw = failure -> triggers retry/backoff or DLQ.
});

queue.startWorkers();
```

That handler function is the entire user-defined surface — arbitrary code,
arbitrary side effects. Everything else (polling, leasing, heartbeats,
turning a throw into a backoff-scheduled retry or DLQ transition) is
handled by the SDK/engine, not the user.

**Configurable per worker process** (how aggressively it consumes work):
```ts
queue.startWorkers({
  concurrency: 10,          // jobs run in parallel per process
  pollIntervalMs: 1000,     // how often to check for new work when idle
  jobTypes: ["send_email"], // optional filter: only claim these types
});
```

**Configurable per job** (set at enqueue time):
```ts
queue.enqueue("send_email", payload, {
  maxAttempts: 3,
  priority: 5,
  dedupeKey: `email-${userId}-${templateId}`,
  runAfter: new Date(Date.now() + 60_000), // delayed job
});
```

**Scaling model:** run as many worker processes as you want, on as many
machines as you want — they coordinate through nothing but the
`SKIP LOCKED` claim query against the same Postgres table. No worker-to-
worker communication needed; this is the actual "distributed" part of the
system.

**Graceful shutdown:** on `SIGTERM`, a worker should stop claiming new jobs,
let in-flight ones finish (or requeue them if they exceed a timeout), then
exit — otherwise a deploy/restart silently drops or corrupts in-progress
work. Needed day one, not an afterthought.

**Long-running jobs and lease renewal:** the default 30s lease is a
heartbeat interval, not a job-duration limit. A worker running a long task
(a multi-minute AI inference job, say) calls `renewLease(jobId, workerId)`
periodically while it's still working, extending `locked_until` each time —
so the lease only needs to outlast the gap between heartbeats. If a worker
genuinely dies, heartbeats stop, the lease actually expires, and the
sweeper (see below) reclaims it.

### Resource specs (RAM/CPU/GPU) for compute-heavy workers

The queue engine doesn't and can't allocate hardware — that's an
infrastructure-layer concern, set on the worker's container/process, not by
the queue:
```yaml
services:
  worker-gpu:
    image: myapp/ai-worker:latest
    deploy:
      resources:
        limits: { cpus: "4", memory: 16G }
    runtime: nvidia   # GPU passthrough
```
(Same idea under Kubernetes via `resources.limits` / `nvidia.com/gpu`.)

What the queue *does* help with is **routing the right job to the right
worker**, via **named worker pools** (same mental model as RunPod's
pod/endpoint types) — groups of workers that share a hardware spec, so a
GPU/heavy job never lands on a worker that can't handle it.

A pool is not one worker — it's however many **replica** processes you run
of that pool's image, each independently claiming and running jobs:

```yaml
services:
  worker-standard:                 # pool: "standard" — 256MB RAM, 0.5 vCPU
    environment: [WORKER_POOL=standard]
    deploy:
      replicas: 3                  # 3 independent "standard" workers running
      resources: { limits: { memory: 256M, cpus: "0.5" } }

  worker-beefy:                    # pool: "beefy" — 2GB RAM, 1.5 vCPU
    environment: [WORKER_POOL=beefy]
    deploy:
      replicas: 1
      resources: { limits: { memory: 2G, cpus: "1.5" } }
```
(replica count adjustable live via `docker compose up --scale worker-standard=5`)

Assignment happens in two separate places:
1. **Deploy time** — how many replicas of each pool run, and what hardware
   each gets (a Docker/Kubernetes resource limit, not something the queue
   controls). Disk/SSD isn't sized per-pool the way RAM/CPU are; only
   relevant if a job needs scratch space, via a mounted volume.
2. **Enqueue time** — which pool a given job needs:
   ```ts
   queue.enqueue("send_email", payload, { pool: "standard" });
   queue.enqueue("run_ai_inference", payload, { pool: "beefy" });
   ```

Mechanically: worker registers its pool (`registerWorker(type, handler, { pool: "beefy" })`),
job declares its pool at enqueue, claim query filters `WHERE pool = $1`
(falls back to any worker if unspecified). Schema addition needed:
`pool TEXT` column on `jobs`.

### Autoscaling (part of initial deployment)

The queue routes jobs to whichever pool workers are alive, but doesn't add
or remove replicas on its own by default — the **autoscaler service**
closes that gap and ships as part of v1, not a later stretch goal.

1. **Signal:** pending-job count per pool, and age of the oldest pending
   job (not just count):
   ```sql
   SELECT pool, count(*) FROM jobs WHERE status = 'pending' GROUP BY pool;
   ```
2. **Controller:** a separate watcher service (its own container in
   `docker-compose.yml`) polling that signal on an interval and adjusting
   replica count. Lives outside the engine — engine just exposes queue
   depth via the API; the autoscaler is the only thing that calls it.
3. **Provisioning backend (pluggable, varies by where compute lives):**
   - **Docker (default self-host target)** — the autoscaler talks to the
     Docker Engine API directly (mounted `/var/run/docker.sock`) to start
     or stop worker containers for a pool's service, i.e. it does
     programmatically what `docker compose up --scale worker-standard=5`
     does by hand. This is the path that has to work for v1, since Docker
     Compose is the default self-host deployment.
   - **Kubernetes** (for anyone running there instead) — **KEDA**'s native
     Postgres scaler can drive a `Deployment`'s replica count directly off
     a SQL query, no custom controller needed.
   - **RunPod** — controller rents/releases a GPU pod via RunPod's API when
     a GPU pool backs up/empties — fits since GPU workers are RunPod's
     whole business, avoids owning the GPU yourself.
   - **Cloud VM groups (AWS ASG / GCP MIG)** — controller adjusts desired
     instance count via their API.
4. **Config per pool** — user sets the boundaries and sensitivity, the
   autoscaler moves replica count inside that range on its own:
   ```yaml
   pools:
     standard:
       provider: docker
       minWorkers: 2          # default/floor — always running, even idle
       maxWorkers: 10         # ceiling — never exceeded regardless of load
       scaleUpThreshold: 5    # pending jobs before adding a replica
       scaleDownIdleMinutes: 10

     gpu-large:
       provider: runpod
       minWorkers: 0          # fine to scale to zero, expensive pool
       maxWorkers: 5
       scaleUpThreshold: 3
       scaleDownIdleMinutes: 10
   ```

This is deliberately a separate service from the engine (consumes the
queue-depth API, no engine-core changes needed) — its own container,
its own config file, but part of the initial `docker-compose.yml` rather
than bolted on afterward.

## Architecture

```
┌─────────────┐      ┌──────────────────────────┐      ┌─────────────┐
│  Next.js     │◄────►│   Engine (TS + Postgres)  │◄────►│  Postgres    │
│  Dashboard   │      │   - REST API              │      │  (job table, │
└─────────────┘      │   - Claim/lease loop       │      │   DLQ, stats)│
                       │   - Backoff + retry        │      └─────────────┘
┌─────────────┐      │   - Adaptive backoff stats │
│ Client SDKs  │◄────►│   - Claude triage on DLQ   │◄───► Anthropic API
│ TS/C#/Py/Java│      └──────────────────────────┘
└─────────────┘
```

- Engine exposes a REST API (simplest to bind from 4 languages; gRPC adds
  codegen overhead not worth it yet).
- Auth via API keys. `tenants`/`api_keys` tables exist in the schema so
  self-host auth is trivial (one seeded tenant + key per instance) and the
  door to multi-tenant SaaS stays open — but no billing/signup/metering
  gets built until self-hosted adoption justifies it.
- Client SDK surface (same shape across all 4 languages):
  - `enqueue(jobType, payload, options)`
  - `registerWorker(jobType, handler)` — polling/long-polling under the hood
  - `getJobStatus(jobId)`

## Deployment & distribution

- **Source of truth:** GitHub repo (engine, dashboard, SDKs, `docker-compose.yml`).
- **`docker-compose.yml` now exists for real** at the repo root (previously
  this section only ever described one). It builds locally via
  `engine/Dockerfile` rather than pulling from `ghcr.io` — CI publishing
  versioned images there is still a documented future step, not done yet.
- **Default port: `4000`, for everything.** The dashboard is served by the
  engine's own Fastify instance at `/dashboard` (see the Dashboard section
  below) — there is no separate port-3000 service anymore.
- **Database is configurable, not fixed to the bundled container** — this
  was a deliberate later addition. `DATABASE_URL` is the only thing that
  matters; the engine has zero code that assumes anything about where
  Postgres lives. Two supported modes, both driven by the same env var:
  1. **Bundled Postgres:** `docker compose --profile bundled-db up` — the
     `db` service (gated behind the `bundled-db` Compose profile, so it
     never starts unless explicitly requested) plus `DATABASE_URL` pointed
     at `db:5432`.
  2. **Your own existing Postgres** (local, RDS, Supabase, whatever):
     `docker compose up` (no profile flag) with `DATABASE_URL` pointed at
     that instance instead — the `db` service simply never starts.
  Verified directly (not just by inspection): pointed a running engine at a
  freshly created, completely separate Postgres database via `DATABASE_URL`
  alone, with no other code changes, and the full demo suite passed
  identically against it.
- **`docker-compose.yml` shape (actual file, not illustrative):**
  ```yaml
  services:
    db:
      image: postgres:16
      profiles: ["bundled-db"]   # only runs if explicitly requested
      environment:
        - POSTGRES_DB=${POSTGRES_DB:-vigilq}
        - POSTGRES_USER=${POSTGRES_USER:-postgres}
        - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}
      volumes:
        - vigilq_pgdata:/var/lib/postgresql/data
        - ./schema.sql:/docker-entrypoint-initdb.d/schema.sql:ro

    engine:
      build: { context: ., dockerfile: engine/Dockerfile }
      ports: ["4000:4000"]
      environment:
        - DATABASE_URL=${DATABASE_URL}
        - AI_PROVIDER=${AI_PROVIDER:-anthropic}
        - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
        - ANTHROPIC_MODEL=${ANTHROPIC_MODEL}
        - OPENAI_API_KEY=${OPENAI_API_KEY}
        - OPENAI_MODEL=${OPENAI_MODEL}
        - GOOGLE_API_KEY=${GOOGLE_API_KEY}
        - GOOGLE_MODEL=${GOOGLE_MODEL}

    sweeper:
      build: { context: ., dockerfile: engine/Dockerfile }   # same image, different command
      command: ["node", "dist/sweep.js"]
      environment:
        - DATABASE_URL=${DATABASE_URL}
        - SWEEP_CRON_SCHEDULE=${SWEEP_CRON_SCHEDULE:-*/10 * * * * *}

  volumes:
    vigilq_pgdata:
  ```
  `engine/Dockerfile` is a 3-stage build: build the dashboard's static
  export, build the engine's TypeScript, then a slim final image with the
  engine's production `node_modules` + `dist/` + the dashboard's `out/`
  bundled in (`DASHBOARD_DIST_PATH` points at it) — this is what makes the
  same-port dashboard work as a single container.
  **Verified for real** — `docker compose --profile bundled-db up -d --build`
  run end-to-end (see the Status section for the bugs that surfaced and
  got fixed along the way: a pnpm supply-chain policy rejection, a
  TTY-dependent prune command, a missing `packageManager` pin, a DB-ready
  startup race, and a default port conflict).
- **Queue API key (SDK auth):** auto-generated on first boot (one default
  tenant + one key), printed once to container logs (only a hash is
  stored). User copies it into their own app's env (`QUEUE_API_KEY`) for
  the SDK to send as `Authorization: Bearer <key>`.
- **`QUEUE_URL` (where the SDK points):** just an env var the user sets —
  `http://localhost:4000` for local dev, the Compose service name
  (`http://engine:4000`) when their app is containerized on the same
  network, or their real host/domain once deployed.

## AI triage provider (configurable, not Claude-only)

- **`AI_PROVIDER`** env var selects the vendor: `anthropic` (default),
  `openai`, or `google`. Each is fully BYOK — missing that provider's key
  (and, for OpenAI/Google, its model) means triage is silently disabled,
  same rule as before, just now per-provider.
- Implementation lives in `engine/src/triage/` — a `TriageProvider`
  interface (`classify(input): Promise<TriageOutput>`) with one
  implementation per vendor (`anthropicProvider.ts`, `openaiProvider.ts`,
  `googleProvider.ts`), all using each vendor's forced tool/function-calling
  mode so the classification always comes back as structured data, never
  free-form prose to parse. A factory (`getConfiguredProvider()`) reads
  `AI_PROVIDER` and constructs the right one; `triageDeadLetterJob()` is
  unchanged from before — it just calls whatever provider the factory hands
  it.
- Anthropic keeps a default model (`claude-sonnet-5`) since that's
  known-current; OpenAI/Google have **no guessed default** — `OPENAI_MODEL`/
  `GOOGLE_MODEL` must be set explicitly, since a hardcoded "current" model
  id for those would go stale fast and a config error is better than
  silently calling something deprecated.
- **Tested:** the factory's provider-selection logic (7 cases — no key,
  key but no model, key+model, unknown provider name — all verified
  without needing real API keys, since construction doesn't call out to
  the vendor). **Not tested:** actually calling OpenAI's or Google's APIs
  (no keys available this session) — same honest gap as Claude's actual
  API call before it.

## Dashboard (monitoring UI)

- Served by the **engine's own Fastify server**, same port as the API
  (`http://localhost:4000/dashboard`) — not a separate service/port. Built
  as a Next.js static export, served via `@fastify/static`, mounted at
  `/dashboard` so it can't collide with any API route.
- Just another API client under the hood: hits the same REST API
  (`/jobs`, `/pools/depths`, `/jobs/:id/attempts`, `/jobs/:id/triage`) the
  SDKs use — no special backend code.
- Views: Overview (status tiles + pool depths), Jobs (filterable list),
  job detail (query-param based, since static export can't do dynamic
  routes), and a **Dead Letter view showing each dead job's AI triage
  result** (classification + suggested fix, whichever provider produced
  it) — the main place the AI twist becomes visible/useful to a user.
- Auth: no server-side session (there's no backend of its own) — the queue
  API key is entered once client-side, verified against the real API, and
  kept in `localStorage`.

## Business model (deferred until there's adoption)

- **Self-hosted (the actual near-term focus):** free/open source. User runs
  their own Postgres (bundled or their own instance — see Deployment
  section) + engine via Docker Compose, pays nothing to us, uses their own
  API key for whichever AI provider they pick (`AI_PROVIDER` +
  provider-specific key — BYOK is required for self-host, since there's no
  way to meter someone else's container regardless of which vendor).
- **SaaS (only if self-hosted takes off):** tiered pricing on the things
  that cost us money to provide — job volume/month, history retention,
  AI triage calls/month (a "managed" mode using our own key for whichever
  provider, metered per tenant), concurrent worker connections. Free / Pro
  / Enterprise tiers. Not built until there's a real reason to.

## Build order

1. **Postgres schema** — jobs table (incl. `pool` column), dead_letter
   table, per-job-type stats table for adaptive backoff.
2. **Engine core** — enqueue, claim (`SKIP LOCKED`, pool-aware), lease
   sweeper, retry + backoff/jitter, DLQ transition, idempotency/dedupe.
3. **REST API** — wraps engine core; API key auth; queue-depth-per-pool
   endpoint for the autoscaler to consume.
4. **TS SDK** — first client, dogfoods the API design (incl. pool options
   on `enqueue`/`registerWorker`).
5. **Adaptive backoff** — per-job-type stats feeding retry timing/limits.
6. **AI triage** (Claude first, then made provider-configurable — Claude/
   GPT/Gemini) — DLQ hook that classifies + suggests fixes.
7. **Autoscaler service** — Docker-backend first (talks to Docker Engine
   API to add/remove pool replicas), config-driven min/max per pool.
8. **Next.js dashboard** — job states, metrics, DLQ + triage view, pool/
   replica visibility.
9. **C# SDK**, then **Python SDK**, then **Java SDK** — thin HTTP wrappers.
10. **Stretch:** embedded/in-process mode (no separate service, SQLite-backed)
    for the TS package; Kubernetes/KEDA and RunPod autoscaler backends.

## Status

- [x] Idea + architecture defined
- [x] Postgres schema (`schema.sql`)
- [x] Real `docker-compose.yml` + `engine/Dockerfile` (repo root) — 3-stage
      build (dashboard static export → engine TS build → slim runtime
      image), configurable DB via `DATABASE_URL` (bundled Postgres behind
      the `bundled-db` Compose profile, or any external instance).
      **Verified end-to-end for real**: `docker compose --profile
      bundled-db up -d --build` — all three containers (db, engine,
      sweeper) healthy, dashboard reachable, a real job enqueued and
      persisted through the actual containerized stack. Found and fixed
      three genuine bugs along the way: (1) pnpm's `minimumReleaseAge`
      supply-chain check rejecting a lockfile entry — fixed via `.npmrc`
      (`minimum-release-age=0`) in both `engine/` and `dashboard/`; (2)
      `pnpm prune --prod` requiring an interactive TTY confirmation that
      doesn't exist in a Docker build — fixed with `CI=true`; (3) the real
      root cause of #1 recurring: `dashboard/package.json` was the only
      `package.json` in the repo missing the `packageManager` pin every
      other one has, so its build silently used a newer, stricter pnpm.
      Also fixed a startup race — the engine tried to query Postgres
      before the bundled `db` container was ready to accept connections
      (no `depends_on` on purpose, since that would break "point at your
      own Postgres" mode); added `waitForDatabase()` retry-with-backoff in
      `engine/src/db.ts`, called before anything else in `index.ts`. And
      one deployment default fixed: the bundled `db` service published
      port 5432 to the host by default, conflicting with any developer's
      own local Postgres (as it did here) — removed the host port publish
      entirely, since engine/sweeper only ever need the internal Docker
      network hostname anyway.
- [x] Engine core (`engine/src/queue.ts`, `tenant.ts`, `sweep.ts`) —
      enqueue, claim (SKIP LOCKED, pool-aware), complete, fail + backoff/
      DLQ, dedupe, lease renewal, cron-based expired-lease sweeper. All
      demoed against live Postgres (`engine/src/demo.ts`).
- [x] REST API (`engine/src/server.ts`, Fastify + Zod) — API-key auth
      (tenant-scoped, backed by `apiKey.ts`), `/health`, `/jobs` (enqueue,
      list), `/jobs/:id` (get), `/jobs/claim`, `/jobs/:id/renew`,
      `/jobs/:id/complete`, `/jobs/:id/fail`, `/pools/depths` (for the
      future autoscaler). Verified end-to-end over real HTTP against
      live Postgres.
- [x] TS SDK (`sdks/typescript`, `vigilq-client`) — `enqueue()`,
      `getJobStatus()`, `registerWorker()`/`startWorkers()` (concurrent
      poll loops, automatic lease renewal via heartbeat while a handler
      runs, complete/fail reporting), graceful `stop()`. Verified end-to-end
      against the live engine, including a retry-then-succeed scenario.
      **Bug found and fixed:** `pool` was accepted by `registerWorker()` but
      never actually forwarded on the claim request — every worker was
      silently in wildcard mode regardless of what was passed. Moved
      `pool` to `StartWorkersOptions` (it's a property of the whole worker
      process, not per-handler) and wired it into the claim call. Verified
      with three jobs (two different pools + one unassigned) against one
      real worker — it claimed its own pool's job and the unassigned one,
      correctly left the other pool's job untouched. **C# and Python SDKs
      have this identical gap, unfixed** — same missing wiring.
- [x] Adaptive backoff (`engine/src/adaptiveBackoff.ts`) — per
      (tenant, job_type, attempt_number) success/failure counts recorded on
      every completion/failure; retry backoff scaled by historical success
      rate (falls back to the plain static exponential curve below
      `MIN_SAMPLES`). Verified two job types with different failure
      profiles get measurably different retry timing from the same base
      curve. Caught and fixed a real bug along the way: Postgres `BIGINT`
      columns return as strings via `pg`, so naive `+` silently
      concatenated instead of adding.
- [x] AI triage, now multi-provider (`engine/src/triage/` — `types.ts`,
      `anthropicProvider.ts`, `openaiProvider.ts`, `googleProvider.ts`,
      `index.ts`'s factory) — wired into `failJob()`/`sweepExpiredLeases()`
      (fires only after the DLQ transition's transaction commits,
      fire-and-forget, never blocks the retry path). Each provider uses
      forced tool/function-calling for structured output. `AI_PROVIDER`
      picks the vendor; BYOK per-provider, silently no-ops without that
      provider's key (+model, for OpenAI/Google). **Tested:** provider
      factory selection logic (7 cases, no real API calls needed).
      **Not tested:** an actual live call to any of the three vendors — no
      real API keys available this session.
- [x] Autoscaler (`autoscaler/`, Docker backend) — separate service, polls
      the engine's `/pools/depths` over HTTP on an interval, decides
      replica counts via a pure `computeDesiredReplicas()` function (scales
      by one replica per tick in either direction to avoid flapping,
      respects per-pool min/max bounds, scale-up threshold, scale-down idle
      timer), executes changes via `docker compose ... --scale` (shells out
      to the Compose CLI rather than the raw Docker Engine API, since
      Compose outside Swarm mode has no native "service" concept to scale
      via the Engine API the way Swarm does). Config lives in a YAML file
      the autoscaler reads directly — it never touches Postgres, matching
      the "engine only exposes queue depth" design.
      **Tested:** decision logic (9 unit tests, no infra needed), the
      engine HTTP client (verified live against the running engine,
      including the `pending_count` BIGINT-as-string gotcha), and the YAML
      config loader. **Not tested:** the actual `docker compose` scaling
      calls — this project has no real `docker-compose.yml` /
      multi-container deployment running yet to verify against.
- [x] Next.js dashboard (`dashboard/`) — served from the **same port as
      the engine** (`http://localhost:4000/dashboard/`), not a separate
      3000. Built as a static export (`output: "export"`, `trailingSlash:
      true`) and served by the engine's own Fastify instance via
      `@fastify/static`, mounted at `/dashboard` so it can't collide with
      any existing API route. Pages: Overview (status tiles + pool
      depths), Jobs (filterable list), job detail (query-param based —
      `/jobs/detail?id=...`, since static export can't do dynamic `[id]`
      routes), Dead Letter (the AI-triage showcase view). Auth is a simple
      client-side gate: the queue API key is entered once and stored in
      `localStorage`, verified against the real API — no server-side
      session needed since the dashboard has no backend of its own.
      New engine endpoints added to support it:
      `GET /jobs/stats/status-counts`, `GET /jobs/:id/attempts`,
      `GET /jobs/:id/triage`. **Verified:** all three new endpoints against
      live data (including a real dead-lettered job's attempt history),
      and the dashboard's actual page rendering via a real headless
      Chrome run (confirms the JS bundle executes and React hydrates, not
      just that the HTML shell loads) — login gate visible, API calls
      correctly 401 without a key, `/health` and `/dashboard/*` unaffected.
- [x] C# SDK (`sdks/csharp`, `Vigilq.Client`) — `EnqueueAsync`,
      `GetJobStatusAsync`, `RegisterWorker<T>`/`StartWorkersAsync` (parallel
      poll loops via `Task`, automatic lease-renewal heartbeat, complete/
      fail reporting), graceful `StopAsync`. Verified end-to-end via a demo
      console app against the live engine, including a retry-then-succeed
      scenario. **Caught and fixed a real cross-SDK bug along the way:**
      C#'s `Dictionary<string, object?>` serializes a `null` value as an
      explicit JSON `null`, but the engine's Zod schemas use `.optional()`
      (accepts a missing key, rejects an explicit `null`) — unset optional
      fields must be omitted from the request body entirely, not sent as
      `null`. Fixed via an `OmitNulls` helper before every request that has
      optional fields.
- [x] Python SDK (`sdks/python`, `vigilq_client`) — same surface
      (`enqueue`, `get_job_status`, `register_worker`/`start_workers` using
      threads for concurrency + a heartbeat thread per in-flight job,
      `stop`). Applied the same null-omission fix proactively from the
      start (kwargs default to `None` and are only added to the request
      dict if set) — worked correctly on the first live run against the
      engine, including its own retry-then-succeed scenario.
- [ ] Java SDK — deliberately deferred (no Maven/Gradle available in this
      environment yet); same design (thin HTTP client, same method
      surface) once picked back up.
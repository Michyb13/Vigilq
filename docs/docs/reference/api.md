---
sidebar_position: 2
title: REST API
---

# REST API

The SDKs are thin wrappers around this — everything here is plain HTTP, usable from any language. Every route except `/health` and `/dashboard/*` requires `Authorization: Bearer <api key>`.

## `GET /health`

No auth required. `{ "status": "ok" }`.

## `POST /jobs`

Enqueue a job.

```json
{
  "jobType": "send_email",
  "payload": { "to": "user@example.com" },
  "pool": "standard",
  "priority": 0,
  "maxAttempts": 3,
  "dedupeKey": "welcome-usr_123",
  "runAfter": "2026-01-01T00:00:00Z"
}
```

Only `jobType` and `payload` are required. Returns `201` with `{ enqueued: true, job }`, or `200` with `{ enqueued: false, reason: "duplicate dedupeKey" }` if `dedupeKey` collided.

## `GET /jobs`

List jobs. Query params: `status`, `pool`, `jobType`, `limit` (max 200, default 50).

## `GET /jobs/:id`

Fetch one job. `404` if not found (or belongs to a different tenant).

## `POST /jobs/claim`

Atomically claim one pending, due job.

```json
{ "workerId": "worker-1", "jobTypes": ["send_email"], "pool": "standard", "leaseSeconds": 30 }
```

Returns `204` if nothing claimable, or `200` with `{ job }`.

## `POST /jobs/:id/renew`

Extend a held job's lease. `{ "workerId": "worker-1", "leaseSeconds": 30 }`. `409` if the job isn't running or is held by a different worker.

## `POST /jobs/:id/complete`

`{ "workerId": "worker-1" }` — marks the job `completed`.

## `POST /jobs/:id/fail`

```json
{ "workerId": "worker-1", "errorMessage": "timeout", "errorStack": "..." }
```

Requeues with backoff, or moves to `dead_letter` if attempts are exhausted.

## `GET /pools/depths`

Pending-job count per pool — what the autoscaler polls.

## `GET /jobs/stats/status-counts`

Job count per status — what the dashboard's Overview page shows.

## `GET /jobs/:id/attempts`

Full attempt history for one job (worker id, outcome, error message per attempt).

## `GET /jobs/:id/triage`

The AI provider's classification for a dead-lettered job. `404` if triage hasn't run yet (no provider configured, or it just hasn't happened).

-- Up Migration
-- Vigilq initial schema. See plan.md for the full design rationale.
-- No down migration for this one on purpose — reversing it means dropping
-- every table in the system, which isn't a meaningful "undo" for v1.
-- Future migrations should each include a real down migration.

-- ============================================================
-- Multi-tenancy (self-host auto-seeds one tenant + one key;
-- same schema used if/when SaaS mode is ever built)
-- ============================================================

CREATE TABLE tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    key_hash    TEXT NOT NULL UNIQUE,   -- raw key is only ever shown once, at creation
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ
);

-- ============================================================
-- The mailbox
-- ============================================================

CREATE TYPE job_status AS ENUM (
    'pending', 'running', 'completed', 'failed', 'dead_letter'
);

CREATE TABLE jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    job_type        TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          job_status NOT NULL DEFAULT 'pending',
    priority        INT NOT NULL DEFAULT 0,          -- higher = claimed first

    pool            TEXT,                            -- worker pool this job requires
                                                       -- (e.g. 'standard', 'gpu-large');
                                                       -- NULL = claimable by any worker

    dedupe_key      TEXT,                             -- idempotency

    attempts        INT NOT NULL DEFAULT 0,
    max_attempts    INT NOT NULL DEFAULT 5,

    run_after       TIMESTAMPTZ NOT NULL DEFAULT now(), -- delay / backoff timer
    locked_by       TEXT,                              -- worker id
    locked_until    TIMESTAMPTZ,                        -- lease expiry

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

-- One row per job per tenant per dedupe key — the idempotency guard
CREATE UNIQUE INDEX jobs_dedupe_idx
    ON jobs (tenant_id, job_type, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- Makes claiming fast: workers only ever scan pending, due jobs,
-- ordered by priority then age, optionally scoped to their pool
CREATE INDEX jobs_claim_idx
    ON jobs (status, pool, run_after, priority DESC)
    WHERE status = 'pending';

-- Autoscaler reads this shape constantly — keep it index-backed
CREATE INDEX jobs_pending_by_pool_idx
    ON jobs (pool, created_at)
    WHERE status = 'pending';

-- ============================================================
-- Attempt history — what AI triage reads, what adaptive backoff
-- aggregates over
-- ============================================================

CREATE TABLE job_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number  INT NOT NULL,
    worker_id       TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    outcome         TEXT,           -- 'success' | 'failure'
    error_message   TEXT,
    error_stack     TEXT
);

CREATE INDEX job_attempts_job_id_idx ON job_attempts (job_id);

-- ============================================================
-- Adaptive backoff: rolling stats per job type, per attempt number
-- ============================================================

CREATE TABLE job_type_stats (
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    job_type        TEXT NOT NULL,
    attempt_number  INT NOT NULL,
    success_count   BIGINT NOT NULL DEFAULT 0,
    failure_count   BIGINT NOT NULL DEFAULT 0,
    avg_duration_ms INT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, job_type, attempt_number)
);

-- ============================================================
-- AI failure triage: one row per dead-lettered job
-- ============================================================

CREATE TABLE dead_letter_triage (
    job_id              UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    classification      TEXT NOT NULL,   -- e.g. 'transient_network', 'bad_payload', 'code_bug'
    suggested_fix       TEXT,
    confidence          NUMERIC(3,2),
    model_used          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Autoscaler config: per-pool boundaries + sensitivity
-- (read by the autoscaler service; not touched by the engine)
-- ============================================================

CREATE TABLE pool_autoscale_config (
    tenant_id               UUID NOT NULL REFERENCES tenants(id),
    pool                    TEXT NOT NULL,
    provider                TEXT NOT NULL DEFAULT 'docker',  -- 'docker' | 'kubernetes' | 'runpod'
    min_workers             INT NOT NULL DEFAULT 1,
    max_workers             INT NOT NULL DEFAULT 5,
    scale_up_threshold      INT NOT NULL DEFAULT 5,   -- pending jobs before adding a replica
    scale_down_idle_minutes INT NOT NULL DEFAULT 10,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, pool)
);

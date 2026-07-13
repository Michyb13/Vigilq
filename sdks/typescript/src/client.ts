export interface Job<TPayload = unknown> {
  id: string;
  tenant_id: string;
  job_type: string;
  payload: TPayload;
  status: "pending" | "running" | "completed" | "failed" | "dead_letter";
  priority: number;
  pool: string | null;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_by: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EnqueueOptions {
  pool?: string;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
  runAfter?: Date;
}

export type JobHandler<TPayload = unknown> = (job: Job<TPayload>) => Promise<void> | void;

export interface StartWorkersOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  /**
   * Which pool this worker process belongs to. A pool is a property of the
   * whole process, not of an individual job type — one process registers
   * handlers for however many job types it wants, but represents one
   * category of hardware, so it declares its pool once here, not per
   * registerWorker() call. Omit entirely to claim from any pool.
   */
  pool?: string;
}

export interface JobQueueClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class JobQueueClient {
  private baseUrl: string;
  private apiKey: string;
  private handlers = new Map<string, JobHandler>();
  private stopping = false;
  private inFlight = new Set<Promise<void>>();
  private workerId: string;

  constructor(opts: JobQueueClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<{ status: number; data: T | null }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return { status: res.status, data: null };

    const data = (await res.json().catch(() => null)) as T | null;

    if (!res.ok && res.status !== 404) {
      throw new Error(`Request to ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    }

    return { status: res.status, data };
  }

  /** Enqueue a job. Returns null if a dedupeKey collision silently rejected it. */
  async enqueue<TPayload = unknown>(
    jobType: string,
    payload: TPayload,
    opts: EnqueueOptions = {}
  ): Promise<Job<TPayload> | null> {
    const { data } = await this.request<{ enqueued: boolean; job?: Job<TPayload> }>(
      "/jobs",
      "POST",
      { jobType, payload, ...opts }
    );
    return data?.job ?? null;
  }

  async getJobStatus<TPayload = unknown>(jobId: string): Promise<Job<TPayload> | null> {
    const { status, data } = await this.request<{ job: Job<TPayload> }>(`/jobs/${jobId}`, "GET");
    if (status === 404) return null;
    return data?.job ?? null;
  }

  /** Register a handler for a job type. Call startWorkers() to begin processing. */
  registerWorker<TPayload = unknown>(jobType: string, handler: JobHandler<TPayload>): void {
    this.handlers.set(jobType, handler as JobHandler);
  }

  /**
   * Start polling for jobs matching the registered handlers. Runs
   * `concurrency` claim loops in parallel; each claims one job at a time,
   * runs its handler, and reports success/failure back to the engine.
   * While a job is executing, its lease is renewed periodically so a
   * long-running handler is never mistaken for a crashed worker by the
   * engine's sweeper.
   */
  async startWorkers(opts: StartWorkersOptions = {}): Promise<void> {
    const concurrency = opts.concurrency ?? 5;
    const pollIntervalMs = opts.pollIntervalMs ?? 1000;
    const leaseSeconds = opts.leaseSeconds ?? 30;
    const jobTypes = [...this.handlers.keys()];

    if (jobTypes.length === 0) {
      throw new Error("startWorkers() called with no handlers registered — call registerWorker() first");
    }

    const loop = async () => {
      while (!this.stopping) {
        const { status, data } = await this.request<{ job: Job }>("/jobs/claim", "POST", {
          workerId: this.workerId,
          jobTypes,
          leaseSeconds,
          ...(opts.pool ? { pool: opts.pool } : {}), // omit entirely rather than send pool: undefined
        });

        if (status === 204 || !data?.job) {
          await sleep(pollIntervalMs);
          continue;
        }

        const job = data.job;
        const handler = this.handlers.get(job.job_type);
        if (!handler) continue; // shouldn't happen — engine only returns registered types

        const heartbeat = setInterval(() => {
          this.request(`/jobs/${job.id}/renew`, "POST", {
            workerId: this.workerId,
            leaseSeconds,
          }).catch(() => {
            /* best-effort; if this fails, the lease will eventually expire
               and the sweeper will reclaim the job as if the worker died */
          });
        }, Math.floor((leaseSeconds * 1000) / 2));

        try {
          await handler(job);
          await this.request(`/jobs/${job.id}/complete`, "POST", { workerId: this.workerId });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          await this.request(`/jobs/${job.id}/fail`, "POST", {
            workerId: this.workerId,
            errorMessage: error.message,
            errorStack: error.stack,
          });
        } finally {
          clearInterval(heartbeat);
        }
      }
    };

    const runners: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const p = loop();
      this.inFlight.add(p);
      runners.push(p);
    }

    await Promise.all(runners);
  }

  /** Stop claiming new jobs; resolves once all currently in-flight jobs finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.inFlight);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type JobStatus = "pending" | "running" | "completed" | "failed" | "dead_letter";

export interface Job {
  id: string;
  tenant_id: string;
  job_type: string;
  payload: unknown;
  status: JobStatus;
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

export interface JobAttempt {
  attempt_number: number;
  worker_id: string;
  outcome: "success" | "failure" | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface TriageResult {
  classification: string;
  suggested_fix: string | null;
  confidence: string | number | null;
  model_used: string;
  created_at: string;
}

export interface StatusCount {
  status: JobStatus;
  count: string;
}

export interface PoolDepth {
  pool: string | null;
  pending_count: string;
}

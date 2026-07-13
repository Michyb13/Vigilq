import type { Job, JobAttempt, JobStatus, PoolDepth, StatusCount, TriageResult } from "./types";

/**
 * Every call here is a relative fetch (same-origin, since the dashboard is
 * served by the same Fastify server as the API) — no CORS setup needed,
 * no base URL to configure. The engine's existing API routes are used
 * completely unchanged; this file just wraps them for the UI.
 */
async function apiFetch<T>(path: string, apiKey: string): Promise<{ status: number; data: T | null }> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, data };
}

export async function fetchStatusCounts(apiKey: string): Promise<StatusCount[]> {
  const { data } = await apiFetch<{ counts: StatusCount[] }>("/jobs/stats/status-counts", apiKey);
  return data?.counts ?? [];
}

export async function fetchPoolDepths(apiKey: string): Promise<PoolDepth[]> {
  const { data } = await apiFetch<{ depths: PoolDepth[] }>("/pools/depths", apiKey);
  return data?.depths ?? [];
}

export async function fetchJobs(
  apiKey: string,
  filters: { status?: JobStatus; limit?: number } = {}
): Promise<Job[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  params.set("limit", String(filters.limit ?? 50));

  const { data } = await apiFetch<{ jobs: Job[] }>(`/jobs?${params.toString()}`, apiKey);
  return data?.jobs ?? [];
}

export async function fetchJob(apiKey: string, id: string): Promise<Job | null> {
  const { status, data } = await apiFetch<{ job: Job }>(`/jobs/${id}`, apiKey);
  if (status === 404) return null;
  return data?.job ?? null;
}

export async function fetchJobAttempts(apiKey: string, id: string): Promise<JobAttempt[]> {
  const { data } = await apiFetch<{ attempts: JobAttempt[] }>(`/jobs/${id}/attempts`, apiKey);
  return data?.attempts ?? [];
}

export async function fetchTriage(apiKey: string, id: string): Promise<TriageResult | null> {
  const { status, data } = await apiFetch<{ triage: TriageResult }>(`/jobs/${id}/triage`, apiKey);
  if (status === 404) return null;
  return data?.triage ?? null;
}

/** A quick way to tell whether a stored key is actually valid, for the login gate. */
export async function verifyApiKey(apiKey: string): Promise<boolean> {
  const res = await fetch("/jobs/stats/status-counts", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return res.status !== 401;
}

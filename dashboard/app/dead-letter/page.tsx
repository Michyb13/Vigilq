"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJobs, fetchTriage } from "@/lib/api";
import { useApiKey } from "@/lib/ApiKeyProvider";
import type { Job, TriageResult } from "@/lib/types";

export default function DeadLetterPage() {
  const apiKey = useApiKey();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [triageByJobId, setTriageByJobId] = useState<Record<string, TriageResult | null>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const deadJobs = await fetchJobs(apiKey, { status: "dead_letter", limit: 100 });
      if (cancelled) return;
      setJobs(deadJobs);

      const results = await Promise.all(deadJobs.map((j) => fetchTriage(apiKey, j.id)));
      if (cancelled) return;

      const map: Record<string, TriageResult | null> = {};
      deadJobs.forEach((j, i) => {
        map[j.id] = results[i];
      });
      setTriageByJobId(map);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-accent">
        <span className="h-px w-5 bg-accent" />
        Dead letter
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-balance">Jobs that gave up</h1>
      <p className="mb-7 max-w-xl text-sm text-text-dim">
        Every job here exhausted its retries. Where an AI provider is configured, each one gets a root-cause
        guess and a suggested fix below, generated once and shown here.
      </p>

      {loading ? (
        <p className="text-sm text-text-faint">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-text-faint">Nothing in the dead-letter queue right now.</p>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const triage = triageByJobId[job.id];
            return (
              <Link
                key={job.id}
                href={`/jobs/detail?id=${job.id}`}
                className="block rounded-xl border border-border bg-surface p-4 transition-colors hover:border-status-dead-fg/40"
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-mono font-medium">{job.job_type}</span>
                  <span className="text-xs text-text-faint">{new Date(job.updated_at).toLocaleString()}</span>
                </div>
                <div className="mb-3 font-mono text-xs tabular-nums text-text-faint">
                  {job.attempts} attempts, max {job.max_attempts}
                </div>
                {triage ? (
                  <div className="rounded-lg border border-accent-dim bg-surface-2 p-3 text-sm">
                    <span className="font-medium capitalize text-text">
                      {triage.classification.replace(/_/g, " ")}
                    </span>
                    {triage.suggested_fix && <span className="text-text-dim"> — {triage.suggested_fix}</span>}
                  </div>
                ) : (
                  <div className="text-xs text-text-faint">No AI triage result yet.</div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

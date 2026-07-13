"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchJob, fetchJobAttempts, fetchTriage } from "@/lib/api";
import { useApiKey } from "@/lib/ApiKeyProvider";
import { StatusPill } from "@/lib/StatusPill";
import type { Job, JobAttempt, TriageResult } from "@/lib/types";

function JobDetailContent() {
  const apiKey = useApiKey();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [job, setJob] = useState<Job | null>(null);
  const [attempts, setAttempts] = useState<JobAttempt[]>([]);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      const j = await fetchJob(apiKey, id!);
      const a = await fetchJobAttempts(apiKey, id!);
      const t = j?.status === "dead_letter" ? await fetchTriage(apiKey, id!) : null;
      if (!cancelled) {
        setJob(j);
        setAttempts(a);
        setTriage(t);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiKey, id]);

  if (!id) return <p className="text-sm text-text-faint">No job id given.</p>;
  if (loading) return <p className="text-sm text-text-faint">Loading…</p>;
  if (!job) return <p className="text-sm text-text-faint">Job not found.</p>;

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-accent">
        <span className="h-px w-5 bg-accent" />
        Job detail
      </div>
      <h1 className="mb-1 text-2xl font-semibold text-balance">{job.job_type}</h1>
      <p className="mb-7 font-mono text-xs text-text-faint">{job.id}</p>

      <div className="mb-8 grid grid-cols-2 gap-5 rounded-xl border border-border bg-surface p-5 text-sm sm:grid-cols-4">
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-text-faint">Status</div>
          <StatusPill status={job.status} />
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-text-faint">Attempts</div>
          <div className="font-mono tabular-nums">
            {job.attempts} / {job.max_attempts}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-text-faint">Pool</div>
          <div className="font-mono">{job.pool ?? "—"}</div>
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-text-faint">Priority</div>
          <div className="font-mono tabular-nums">{job.priority}</div>
        </div>
      </div>

      <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-text-faint">Payload</h2>
      <pre className="mb-8 overflow-x-auto rounded-xl border border-border bg-code-bg p-4 font-mono text-xs leading-relaxed">
        {JSON.stringify(job.payload, null, 2)}
      </pre>

      {job.status === "dead_letter" && (
        <>
          <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-text-faint">AI triage</h2>
          {triage ? (
            <div className="mb-8 rounded-xl border border-accent-dim bg-surface p-5 text-sm">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="font-medium capitalize text-text">
                  {triage.classification.replace(/_/g, " ")}
                </span>
                {triage.confidence != null && (
                  <span className="font-mono text-xs tabular-nums text-text-faint">
                    confidence {Number(triage.confidence).toFixed(2)}
                  </span>
                )}
              </div>
              {triage.suggested_fix && <p className="text-text-dim">{triage.suggested_fix}</p>}
              <div className="mt-3 border-t border-border pt-2.5 font-mono text-xs text-text-faint">
                {triage.model_used}
              </div>
            </div>
          ) : (
            <p className="mb-8 text-sm text-text-faint">
              No triage result yet — either it hasn&apos;t run, or no AI provider key is configured on the engine.
            </p>
          )}
        </>
      )}

      <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-text-faint">Attempt history</h2>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-faint">
              <th className="px-4 py-2.5 font-medium">#</th>
              <th className="px-4 py-2.5 font-medium">Worker</th>
              <th className="px-4 py-2.5 font-medium">Outcome</th>
              <th className="px-4 py-2.5 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {attempts.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-4 text-text-faint">
                  No attempts recorded yet.
                </td>
              </tr>
            ) : (
              attempts.map((a) => (
                <tr key={a.attempt_number} className="border-t border-border">
                  <td className="px-4 py-2.5 font-mono tabular-nums">{a.attempt_number}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-dim">{a.worker_id}</td>
                  <td className="px-4 py-2.5 capitalize">
                    <span
                      className={
                        a.outcome === "success" ? "text-status-completed-fg" : "text-status-failed-fg"
                      }
                    >
                      {a.outcome ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-dim">{a.error_message ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-text-faint">Loading…</p>}>
      <JobDetailContent />
    </Suspense>
  );
}

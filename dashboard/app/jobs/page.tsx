"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJobs } from "@/lib/api";
import { useApiKey } from "@/lib/ApiKeyProvider";
import { StatusPill } from "@/lib/StatusPill";
import type { Job, JobStatus } from "@/lib/types";

const STATUSES: (JobStatus | "all")[] = ["all", "pending", "running", "completed", "failed", "dead_letter"];

export default function JobsPage() {
  const apiKey = useApiKey();
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchJobs(apiKey, status === "all" ? {} : { status }).then((result) => {
      if (!cancelled) {
        setJobs(result);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [apiKey, status]);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-accent">
        <span className="h-px w-5 bg-accent" />
        Jobs
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-balance">All jobs</h1>

      <div className="mb-5 flex gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
              status === s
                ? "bg-accent text-accent-fg"
                : "border border-border bg-surface text-text-dim hover:text-text"
            }`}
          >
            {s === "all" ? "All" : s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-faint">
              <th className="px-4 py-2.5 font-medium">Job type</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Pool</th>
              <th className="px-4 py-2.5 font-medium">Attempts</th>
              <th className="px-4 py-2.5 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-text-faint">
                  Loading…
                </td>
              </tr>
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-text-faint">
                  No jobs found.
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id} className="border-t border-border transition-colors hover:bg-surface-2">
                  <td className="px-4 py-2.5 font-mono">
                    <Link href={`/jobs/detail?id=${job.id}`} className="text-accent hover:underline">
                      {job.job_type}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={job.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-text-dim">{job.pool ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {job.attempts} / {job.max_attempts}
                  </td>
                  <td className="px-4 py-2.5 text-text-faint">{new Date(job.created_at).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { fetchPoolDepths, fetchStatusCounts } from "@/lib/api";
import { useApiKey } from "@/lib/ApiKeyProvider";
import type { JobStatus, PoolDepth, StatusCount } from "@/lib/types";

const STATUS_ORDER: JobStatus[] = ["pending", "running", "completed", "failed", "dead_letter"];

const TILE_STYLES: Record<JobStatus, string> = {
  pending: "text-status-pending-fg",
  running: "text-status-running-fg",
  completed: "text-status-completed-fg",
  failed: "text-status-failed-fg",
  dead_letter: "text-status-dead-fg",
};

const DOT_STYLES: Record<JobStatus, string> = {
  pending: "bg-status-pending-fg",
  running: "bg-status-running-fg",
  completed: "bg-status-completed-fg",
  failed: "bg-status-failed-fg",
  dead_letter: "bg-status-dead-fg",
};

export default function OverviewPage() {
  const apiKey = useApiKey();
  const [counts, setCounts] = useState<StatusCount[]>([]);
  const [depths, setDepths] = useState<PoolDepth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [c, d] = await Promise.all([fetchStatusCounts(apiKey), fetchPoolDepths(apiKey)]);
      if (!cancelled) {
        setCounts(c);
        setDepths(d);
        setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 5000); // simple auto-refresh, no need for anything fancier
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiKey]);

  const countFor = (status: string) => counts.find((c) => c.status === status)?.count ?? "0";

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-accent">
        <span className="h-px w-5 bg-accent" />
        Overview
      </div>
      <h1 className="mb-8 text-2xl font-semibold text-balance">Queue at a glance</h1>

      {loading ? (
        <p className="text-sm text-text-faint">Loading…</p>
      ) : (
        <>
          <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {STATUS_ORDER.map((status) => (
              <div
                key={status}
                className="rounded-xl border border-border bg-surface p-4 shadow-sm"
              >
                <div className={`font-mono text-2xl font-medium tabular-nums ${TILE_STYLES[status]}`}>
                  {countFor(status)}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs capitalize text-text-faint">
                  <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[status]}`} />
                  {status.replace("_", " ")}
                </div>
              </div>
            ))}
          </div>

          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-text-faint">
            Pending jobs by pool
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-faint">
                  <th className="px-4 py-2.5 font-medium">Pool</th>
                  <th className="px-4 py-2.5 font-medium">Pending jobs</th>
                </tr>
              </thead>
              <tbody>
                {depths.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-4 text-text-faint">
                      No pending jobs.
                    </td>
                  </tr>
                ) : (
                  depths.map((d) => (
                    <tr key={d.pool ?? "unassigned"} className="border-t border-border">
                      <td className="px-4 py-2.5 font-mono">{d.pool ?? "(unassigned)"}</td>
                      <td className="px-4 py-2.5 font-mono tabular-nums">{d.pending_count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

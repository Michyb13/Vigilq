import type { JobStatus } from "./types";

const STYLES: Record<JobStatus, string> = {
  pending: "bg-status-pending-bg text-status-pending-fg",
  running: "bg-status-running-bg text-status-running-fg",
  completed: "bg-status-completed-bg text-status-completed-fg",
  failed: "bg-status-failed-bg text-status-failed-fg",
  dead_letter: "bg-status-dead-bg text-status-dead-fg",
};

const DOT_STYLES: Record<JobStatus, string> = {
  pending: "bg-status-pending-fg",
  running: "bg-status-running-fg",
  completed: "bg-status-completed-fg",
  failed: "bg-status-failed-fg",
  dead_letter: "bg-status-dead-fg",
};

export function StatusPill({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STYLES[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[status]}`} />
      {status.replace("_", " ")}
    </span>
  );
}

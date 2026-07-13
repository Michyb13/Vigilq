import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import requests


@dataclass
class Job:
    id: str
    tenant_id: str
    job_type: str
    payload: Any
    status: str
    priority: int
    pool: Optional[str]
    dedupe_key: Optional[str]
    attempts: int
    max_attempts: int
    run_after: str
    locked_by: Optional[str]
    locked_until: Optional[str]
    created_at: str
    updated_at: str
    completed_at: Optional[str]

    @classmethod
    def from_dict(cls, d: dict) -> "Job":
        return cls(
            id=d["id"],
            tenant_id=d["tenant_id"],
            job_type=d["job_type"],
            payload=d["payload"],
            status=d["status"],
            priority=d["priority"],
            pool=d.get("pool"),
            dedupe_key=d.get("dedupe_key"),
            attempts=d["attempts"],
            max_attempts=d["max_attempts"],
            run_after=d["run_after"],
            locked_by=d.get("locked_by"),
            locked_until=d.get("locked_until"),
            created_at=d["created_at"],
            updated_at=d["updated_at"],
            completed_at=d.get("completed_at"),
        )


JobHandler = Callable[[Job], None]


class JobQueueClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.worker_id = f"worker-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self._handlers: Dict[str, JobHandler] = {}
        self._stopping = threading.Event()
        self._threads: List[threading.Thread] = []
        self._session = requests.Session()
        self._session.headers.update({"Authorization": f"Bearer {api_key}"})

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def enqueue(
        self,
        job_type: str,
        payload: Any,
        *,
        pool: Optional[str] = None,
        priority: Optional[int] = None,
        max_attempts: Optional[int] = None,
        dedupe_key: Optional[str] = None,
        run_after: Optional[str] = None,
    ) -> Optional[Job]:
        """Enqueue a job. Returns None if a dedupe_key collision silently rejected it."""
        body: Dict[str, Any] = {"jobType": job_type, "payload": payload}
        # The engine's schema uses Zod's .optional() — a missing key is fine,
        # but an explicit null is rejected — so unset optional fields must be
        # left out of the request body entirely, not sent as None.
        if pool is not None:
            body["pool"] = pool
        if priority is not None:
            body["priority"] = priority
        if max_attempts is not None:
            body["maxAttempts"] = max_attempts
        if dedupe_key is not None:
            body["dedupeKey"] = dedupe_key
        if run_after is not None:
            body["runAfter"] = run_after

        res = self._session.post(self._url("/jobs"), json=body)
        data = res.json()
        if "job" not in data:
            return None
        return Job.from_dict(data["job"])

    def get_job_status(self, job_id: str) -> Optional[Job]:
        res = self._session.get(self._url(f"/jobs/{job_id}"))
        if res.status_code == 404:
            return None
        data = res.json()
        return Job.from_dict(data["job"])

    def register_worker(self, job_type: str, handler: JobHandler) -> None:
        """Register a handler for a job type. Call start_workers() to begin processing."""
        self._handlers[job_type] = handler

    def start_workers(
        self, concurrency: int = 5, poll_interval_ms: int = 1000, lease_seconds: int = 30
    ) -> None:
        """
        Starts `concurrency` poll loops, each in its own thread. Each claims
        one job at a time, runs its registered handler, and reports
        success/failure. While a job runs, its lease is renewed periodically
        (in a second background thread) so a long-running handler is never
        mistaken for a crashed worker by the engine's sweeper.
        """
        if not self._handlers:
            raise RuntimeError(
                "start_workers() called with no handlers registered — call register_worker() first"
            )

        job_types = list(self._handlers.keys())
        self._threads = [
            threading.Thread(
                target=self._run_loop, args=(job_types, poll_interval_ms, lease_seconds), daemon=True
            )
            for _ in range(concurrency)
        ]
        for t in self._threads:
            t.start()
        for t in self._threads:
            t.join()

    def _run_loop(self, job_types: List[str], poll_interval_ms: int, lease_seconds: int) -> None:
        while not self._stopping.is_set():
            claim_res = self._session.post(
                self._url("/jobs/claim"),
                json={"workerId": self.worker_id, "jobTypes": job_types, "leaseSeconds": lease_seconds},
            )

            if claim_res.status_code == 204:
                time.sleep(poll_interval_ms / 1000)
                continue

            data = claim_res.json()
            if "job" not in data:
                time.sleep(poll_interval_ms / 1000)
                continue

            job = Job.from_dict(data["job"])
            handler = self._handlers.get(job.job_type)
            if handler is None:
                continue  # shouldn't happen — engine only returns registered types

            heartbeat_stop = threading.Event()
            heartbeat_thread = threading.Thread(
                target=self._run_heartbeat, args=(job.id, lease_seconds, heartbeat_stop), daemon=True
            )
            heartbeat_thread.start()

            try:
                handler(job)
                self._session.post(self._url(f"/jobs/{job.id}/complete"), json={"workerId": self.worker_id})
            except Exception as e:
                self._session.post(
                    self._url(f"/jobs/{job.id}/fail"),
                    json={
                        "workerId": self.worker_id,
                        "errorMessage": str(e),
                        "errorStack": traceback.format_exc(),
                    },
                )
            finally:
                heartbeat_stop.set()
                heartbeat_thread.join()

    def _run_heartbeat(self, job_id: str, lease_seconds: int, stop_event: threading.Event) -> None:
        interval = lease_seconds / 2
        while not stop_event.wait(interval):
            try:
                self._session.post(
                    self._url(f"/jobs/{job_id}/renew"),
                    json={"workerId": self.worker_id, "leaseSeconds": lease_seconds},
                )
            except Exception:
                # best-effort; if this fails, the lease will eventually expire
                # and the sweeper will reclaim the job as if the worker died
                pass

    def stop(self) -> None:
        """Stop claiming new jobs; returns once all currently in-flight jobs finish."""
        self._stopping.set()
        for t in self._threads:
            t.join()

---
sidebar_position: 3
title: Python
---

# Python SDK

```bash
pip install vigilq-client
```

## Connect

```python
from vigilq_client import JobQueueClient

queue = JobQueueClient(
    base_url=os.environ["QUEUE_URL"],
    api_key=os.environ["QUEUE_API_KEY"],
)
```

## Enqueue a job

```python
job = queue.enqueue("send_email", {"to": "user@example.com", "subject": "Welcome!"},
    max_attempts=3,
    dedupe_key=f"welcome-{user_id}",
    pool="standard",  # optional — see Scaling & pools
)
```

Returns `None` if `dedupe_key` collided with an existing job.

## Process jobs

```python
def handle_email(job):
    send_email(job.payload)
    # raise here to trigger a retry with backoff, or dead-letter after max_attempts

queue.register_worker("send_email", handle_email)
queue.start_workers(concurrency=5, poll_interval_ms=1000)
```

`start_workers()` runs a thread per concurrent poll loop and blocks until `stop()` is called — call it as the last thing your worker process does (or run it in a background thread if your process needs to do other things too).

:::note Worker pools
`pool` is available on `enqueue()` today. Pool-scoped **workers** are currently only wired up in the TypeScript SDK — the Python SDK will claim from any pool regardless of what's configured. Known gap, not a design choice.
:::

## Check a job's status

```python
job = queue.get_job_status(job_id)
job.status  # "pending" | "running" | "completed" | "failed" | "dead_letter"
```

## Graceful shutdown

```python
import signal

signal.signal(signal.SIGTERM, lambda *_: queue.stop())
```

## Full API

| Method | Description |
|---|---|
| `enqueue(job_type, payload, **opts)` | Insert a job. `opts`: `pool`, `priority`, `max_attempts`, `dedupe_key`, `run_after`. |
| `get_job_status(job_id)` | Fetch a job's current row, or `None` if not found. |
| `register_worker(job_type, handler)` | Map a job type to a handler function. |
| `start_workers(concurrency=5, poll_interval_ms=1000, lease_seconds=30)` | Start polling and processing registered job types. Blocks until stopped. |
| `stop()` | Stop claiming new jobs; joins all worker threads once in-flight jobs finish. |

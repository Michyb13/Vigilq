import os
import threading
import time

from vigilq_client import Job, JobQueueClient

base_url = os.environ.get("QUEUE_URL", "http://localhost:4000")
api_key = os.environ.get("QUEUE_API_KEY", "")

client = JobQueueClient(base_url, api_key)

print("--- enqueue via Python SDK ---")
job = client.enqueue("py_test_email", {"to": "py-user@example.com"}, max_attempts=2)
print(f"enqueued: {job.id if job else None} {job.status if job else None}")

print("\n--- enqueue a job designed to fail once, then succeed ---")
flaky = client.enqueue("py_flaky", {"note": "will fail first time"}, max_attempts=3)
print(f"enqueued flaky job: {flaky.id if flaky else None}")

flaky_attempts = {"count": 0}


def handle_email(j: Job) -> None:
    print(f"[worker] processing py_test_email job {j.id}, payload: {j.payload}")


def handle_flaky(j: Job) -> None:
    flaky_attempts["count"] += 1
    n = flaky_attempts["count"]
    print(f"[worker] py_flaky attempt #{n} for job {j.id}")
    if n < 2:
        raise Exception("simulated failure on first attempt")
    print(f"[worker] py_flaky succeeded on attempt #{n}")


client.register_worker("py_test_email", handle_email)
client.register_worker("py_flaky", handle_flaky)

worker_thread = threading.Thread(
    target=client.start_workers, kwargs={"concurrency": 2, "poll_interval_ms": 500}, daemon=True
)
worker_thread.start()

time.sleep(4)

final_email = client.get_job_status(job.id)
print(f"\nfinal status of py_test_email job: {final_email.status if final_email else None}")

final_flaky = client.get_job_status(flaky.id)
print(
    f"final status of py_flaky job: {final_flaky.status if final_flaky else None} "
    f"attempts: {final_flaky.attempts if final_flaky else None}"
)

client.stop()

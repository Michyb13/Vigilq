---
sidebar_position: 2
title: C#
---

# C# SDK

```bash
dotnet add package VigilQ.Client
```

## Connect

```csharp
using VigilQClient;

var queue = new JobQueueClient(
    baseUrl: Environment.GetEnvironmentVariable("QUEUE_URL")!,
    apiKey: Environment.GetEnvironmentVariable("QUEUE_API_KEY")!
);
```

## Enqueue a job

```csharp
var job = await queue.EnqueueAsync("send_email", new { to = "user@example.com", subject = "Welcome!" },
    new EnqueueOptions
    {
        MaxAttempts = 3,
        DedupeKey = $"welcome-{userId}",
        Pool = "standard", // optional — see Scaling & pools
    });
```

Returns `null` if `DedupeKey` collided with an existing job.

## Process jobs

```csharp
queue.RegisterWorker<EmailPayload>("send_email", async (job) =>
{
    await SendEmailAsync(job.Payload);
    // throw here to trigger a retry with backoff, or dead-letter after MaxAttempts
});

await queue.StartWorkersAsync(new StartWorkersOptions
{
    Concurrency = 5,
    PollIntervalMs = 1000,
});
```

`StartWorkersAsync()` runs until `StopAsync()` resolves it — call it as the last thing your worker process does.

:::note Worker pools
`Pool` is available on `EnqueueOptions` today (a job can be tagged for a pool). Pool-scoped **workers** — i.e. a worker process only claiming its own pool's jobs — is currently only wired up in the TypeScript SDK; the C# SDK will claim from any pool regardless of what's passed. This is a known gap, not a design choice — check back if you need pool-scoped workers in C# specifically.
:::

## Check a job's status

```csharp
var job = await queue.GetJobStatusAsync<EmailPayload>(jobId);
job?.Status; // "pending" | "running" | "completed" | "failed" | "dead_letter"
```

## Graceful shutdown

```csharp
AppDomain.CurrentDomain.ProcessExit += async (_, _) => await queue.StopAsync();
```

## Full API

| Method | Description |
|---|---|
| `EnqueueAsync(jobType, payload, options?)` | Insert a job. `EnqueueOptions`: `Pool`, `Priority`, `MaxAttempts`, `DedupeKey`, `RunAfter`. |
| `GetJobStatusAsync<T>(jobId)` | Fetch a job's current row, or `null` if not found. |
| `RegisterWorker<T>(jobType, handler)` | Map a job type to a handler function. |
| `StartWorkersAsync(options?)` | Start polling and processing registered job types. `StartWorkersOptions`: `Concurrency`, `PollIntervalMs`, `LeaseSeconds`. Blocks until stopped. |
| `StopAsync()` | Stop claiming new jobs; resolves once in-flight jobs finish. |

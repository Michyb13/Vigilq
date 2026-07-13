using VigilQClient;

var baseUrl = Environment.GetEnvironmentVariable("QUEUE_URL") ?? "http://localhost:4000";
var apiKey = Environment.GetEnvironmentVariable("QUEUE_API_KEY") ?? "";

var client = new JobQueueClient(baseUrl, apiKey);

Console.WriteLine("--- enqueue via C# SDK ---");
var job = await client.EnqueueAsync("csharp_test_email", new { to = "csharp-user@example.com" }, new EnqueueOptions { MaxAttempts = 2 });
Console.WriteLine($"enqueued: {job?.Id} {job?.Status}");

Console.WriteLine("\n--- enqueue a job designed to fail once, then succeed ---");
var flaky = await client.EnqueueAsync("csharp_flaky", new { note = "will fail first time" }, new EnqueueOptions { MaxAttempts = 3 });
Console.WriteLine($"enqueued flaky job: {flaky?.Id}");

var flakyAttempts = 0;

client.RegisterWorker<Dictionary<string, object>>("csharp_test_email", async (j) =>
{
    Console.WriteLine($"[worker] processing csharp_test_email job {j.Id}");
    await Task.CompletedTask;
});

client.RegisterWorker<Dictionary<string, object>>("csharp_flaky", async (j) =>
{
    flakyAttempts++;
    Console.WriteLine($"[worker] csharp_flaky attempt #{flakyAttempts} for job {j.Id}");
    if (flakyAttempts < 2)
    {
        throw new Exception("simulated failure on first attempt");
    }
    Console.WriteLine($"[worker] csharp_flaky succeeded on attempt #{flakyAttempts}");
    await Task.CompletedTask;
});

var workersTask = client.StartWorkersAsync(new StartWorkersOptions { Concurrency = 2, PollIntervalMs = 500 });

await Task.Delay(4000);

var finalEmail = await client.GetJobStatusAsync<Dictionary<string, object>>(job!.Id);
Console.WriteLine($"\nfinal status of csharp_test_email job: {finalEmail?.Status}");

var finalFlaky = await client.GetJobStatusAsync<Dictionary<string, object>>(flaky!.Id);
Console.WriteLine($"final status of csharp_flaky job: {finalFlaky?.Status} attempts: {finalFlaky?.Attempts}");

await client.StopAsync();
Environment.Exit(0);

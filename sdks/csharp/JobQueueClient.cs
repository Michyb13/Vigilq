using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;

namespace VigilQClient;

public class JobQueueClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _workerId;
    private readonly JsonSerializerOptions _jsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly ConcurrentDictionary<string, Func<RawJob, Task>> _handlers = new();
    private volatile bool _stopping;
    private readonly List<Task> _loopTasks = new();

    public JobQueueClient(string baseUrl, string apiKey)
    {
        _http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/") };
        _http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        _workerId = $"worker-{Environment.ProcessId}-{Guid.NewGuid().ToString("N")[..8]}";
    }

    /// <summary>Enqueue a job. Returns null if a dedupeKey collision silently rejected it.</summary>
    public async Task<Job<TPayload>?> EnqueueAsync<TPayload>(string jobType, TPayload payload, EnqueueOptions? options = null)
    {
        options ??= new EnqueueOptions();
        // The engine's schema uses Zod's .optional() (missing key = fine,
        // explicit null = rejected), but C#'s Dictionary serialization always
        // emits a key even when its value is null — so optional fields the
        // caller didn't set must be left out of the dictionary entirely,
        // not included with a null value.
        var body = OmitNulls(new Dictionary<string, object?>
        {
            ["jobType"] = jobType,
            ["payload"] = payload,
            ["pool"] = options.Pool,
            ["priority"] = options.Priority,
            ["maxAttempts"] = options.MaxAttempts,
            ["dedupeKey"] = options.DedupeKey,
            ["runAfter"] = options.RunAfter,
        });

        var res = await _http.PostAsJsonAsync("jobs", body);
        var doc = await res.Content.ReadFromJsonAsync<JsonElement>();
        if (!doc.TryGetProperty("job", out var jobEl)) return null;

        var raw = jobEl.Deserialize<RawJob>(_jsonOptions)!;
        return raw.ToTyped<TPayload>(_jsonOptions);
    }

    public async Task<Job<TPayload>?> GetJobStatusAsync<TPayload>(string jobId)
    {
        var res = await _http.GetAsync($"jobs/{jobId}");
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound) return null;

        var doc = await res.Content.ReadFromJsonAsync<JsonElement>();
        if (!doc.TryGetProperty("job", out var jobEl)) return null;

        var raw = jobEl.Deserialize<RawJob>(_jsonOptions)!;
        return raw.ToTyped<TPayload>(_jsonOptions);
    }

    /// <summary>Register a handler for a job type. Call StartWorkersAsync() to begin processing.</summary>
    public void RegisterWorker<TPayload>(string jobType, Func<Job<TPayload>, Task> handler)
    {
        _handlers[jobType] = async (raw) =>
        {
            var typed = raw.ToTyped<TPayload>(_jsonOptions);
            await handler(typed);
        };
    }

    /// <summary>
    /// Starts `Concurrency` poll loops. Each claims one job at a time, runs
    /// its registered handler, and reports success/failure. While a job runs,
    /// its lease is renewed periodically so a long-running handler is never
    /// mistaken for a crashed worker by the engine's sweeper.
    /// </summary>
    public async Task StartWorkersAsync(StartWorkersOptions? options = null)
    {
        options ??= new StartWorkersOptions();
        if (_handlers.IsEmpty)
            throw new InvalidOperationException("StartWorkersAsync() called with no handlers registered — call RegisterWorker() first");

        var jobTypes = _handlers.Keys.ToList();

        for (var i = 0; i < options.Concurrency; i++)
        {
            var loop = RunLoopAsync(jobTypes, options);
            _loopTasks.Add(loop);
        }

        await Task.WhenAll(_loopTasks);
    }

    private async Task RunLoopAsync(List<string> jobTypes, StartWorkersOptions options)
    {
        while (!_stopping)
        {
            var claimBody = new Dictionary<string, object?>
            {
                ["workerId"] = _workerId,
                ["jobTypes"] = jobTypes,
                ["leaseSeconds"] = options.LeaseSeconds,
            };

            var claimRes = await _http.PostAsJsonAsync("jobs/claim", claimBody);
            if (claimRes.StatusCode == System.Net.HttpStatusCode.NoContent)
            {
                await Task.Delay(options.PollIntervalMs);
                continue;
            }

            var doc = await claimRes.Content.ReadFromJsonAsync<JsonElement>();
            if (!doc.TryGetProperty("job", out var jobEl))
            {
                await Task.Delay(options.PollIntervalMs);
                continue;
            }

            var raw = jobEl.Deserialize<RawJob>(_jsonOptions)!;
            if (!_handlers.TryGetValue(raw.JobType, out var handler)) continue; // shouldn't happen — engine only returns registered types

            using var heartbeatCts = new CancellationTokenSource();
            var heartbeat = RunHeartbeatAsync(raw.Id, options.LeaseSeconds, heartbeatCts.Token);

            try
            {
                await handler(raw);
                await _http.PostAsJsonAsync($"jobs/{raw.Id}/complete", new { workerId = _workerId });
            }
            catch (Exception ex)
            {
                var failBody = OmitNulls(new Dictionary<string, object?>
                {
                    ["workerId"] = _workerId,
                    ["errorMessage"] = ex.Message,
                    ["errorStack"] = ex.StackTrace, // can be null — same optional-vs-null issue as EnqueueAsync
                });
                await _http.PostAsJsonAsync($"jobs/{raw.Id}/fail", failBody);
            }
            finally
            {
                heartbeatCts.Cancel();
                try { await heartbeat; } catch (OperationCanceledException) { }
            }
        }
    }

    private async Task RunHeartbeatAsync(string jobId, int leaseSeconds, CancellationToken token)
    {
        var interval = TimeSpan.FromMilliseconds(leaseSeconds * 1000 / 2.0);
        while (!token.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(interval, token);
                await _http.PostAsJsonAsync($"jobs/{jobId}/renew", new { workerId = _workerId, leaseSeconds }, token);
            }
            catch (OperationCanceledException)
            {
                // expected on job completion — the lease renewal loop for this job just stops
            }
            catch
            {
                // best-effort; if this fails, the lease will eventually expire and
                // the sweeper will reclaim the job as if the worker died
            }
        }
    }

    /// <summary>Stop claiming new jobs; returns once all currently in-flight jobs finish.</summary>
    public async Task StopAsync()
    {
        _stopping = true;
        await Task.WhenAll(_loopTasks);
    }

    public void Dispose() => _http.Dispose();

    private static Dictionary<string, object?> OmitNulls(Dictionary<string, object?> dict) =>
        dict.Where(kv => kv.Value != null).ToDictionary(kv => kv.Key, kv => kv.Value);
}

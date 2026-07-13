using System.Text.Json;
using System.Text.Json.Serialization;

namespace VigilQClient;

/// <summary>
/// Internal wire representation — Payload stays a raw JsonElement here so one
/// dictionary of handlers can hold multiple job types with different payload
/// shapes. registerWorker&lt;T&gt;() deserializes Payload into T only at the
/// point a specific handler is actually invoked.
/// </summary>
internal record RawJob
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("tenant_id")] public string TenantId { get; init; } = "";
    [JsonPropertyName("job_type")] public string JobType { get; init; } = "";
    [JsonPropertyName("payload")] public JsonElement Payload { get; init; }
    [JsonPropertyName("status")] public string Status { get; init; } = "";
    [JsonPropertyName("priority")] public int Priority { get; init; }
    [JsonPropertyName("pool")] public string? Pool { get; init; }
    [JsonPropertyName("dedupe_key")] public string? DedupeKey { get; init; }
    [JsonPropertyName("attempts")] public int Attempts { get; init; }
    [JsonPropertyName("max_attempts")] public int MaxAttempts { get; init; }
    [JsonPropertyName("run_after")] public string RunAfter { get; init; } = "";
    [JsonPropertyName("locked_by")] public string? LockedBy { get; init; }
    [JsonPropertyName("locked_until")] public string? LockedUntil { get; init; }
    [JsonPropertyName("created_at")] public string CreatedAt { get; init; } = "";
    [JsonPropertyName("updated_at")] public string UpdatedAt { get; init; } = "";
    [JsonPropertyName("completed_at")] public string? CompletedAt { get; init; }

    public Job<TPayload> ToTyped<TPayload>(JsonSerializerOptions jsonOptions)
    {
        var payload = Payload.Deserialize<TPayload>(jsonOptions)!;
        return new Job<TPayload>
        {
            Id = Id,
            TenantId = TenantId,
            JobType = JobType,
            Payload = payload,
            Status = Status,
            Priority = Priority,
            Pool = Pool,
            DedupeKey = DedupeKey,
            Attempts = Attempts,
            MaxAttempts = MaxAttempts,
            RunAfter = RunAfter,
            LockedBy = LockedBy,
            LockedUntil = LockedUntil,
            CreatedAt = CreatedAt,
            UpdatedAt = UpdatedAt,
            CompletedAt = CompletedAt,
        };
    }
}

public record Job<TPayload>
{
    public string Id { get; init; } = "";
    public string TenantId { get; init; } = "";
    public string JobType { get; init; } = "";
    public TPayload Payload { get; init; } = default!;
    public string Status { get; init; } = "";
    public int Priority { get; init; }
    public string? Pool { get; init; }
    public string? DedupeKey { get; init; }
    public int Attempts { get; init; }
    public int MaxAttempts { get; init; }
    public string RunAfter { get; init; } = "";
    public string? LockedBy { get; init; }
    public string? LockedUntil { get; init; }
    public string CreatedAt { get; init; } = "";
    public string UpdatedAt { get; init; } = "";
    public string? CompletedAt { get; init; }
}

public class EnqueueOptions
{
    public string? Pool { get; set; }
    public int? Priority { get; set; }
    public int? MaxAttempts { get; set; }
    public string? DedupeKey { get; set; }
    public DateTime? RunAfter { get; set; }
}

public class StartWorkersOptions
{
    public int Concurrency { get; set; } = 5;
    public int PollIntervalMs { get; set; } = 1000;
    public int LeaseSeconds { get; set; } = 30;
}

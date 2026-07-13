import { sql } from "kysely";
import { db } from "../db.js";
import { TriageProvider } from "./types.js";
import { AnthropicTriageProvider } from "./anthropicProvider.js";
import { OpenAITriageProvider } from "./openaiProvider.js";
import { GoogleTriageProvider } from "./googleProvider.js";

export type { TriageProvider, TriageInput, TriageOutput } from "./types.js";

/**
 * Which AI provider handles dead-letter triage — configurable via
 * AI_PROVIDER (default "anthropic"). Each provider is BYOK: missing the
 * relevant API key means triage is silently disabled, same as before, just
 * now with a choice of which vendor "silently disabled" applies to.
 *
 * Model name has no guessed default for OpenAI/Google — it must be set
 * explicitly (OPENAI_MODEL / GOOGLE_MODEL), since model identifiers change
 * fast and a stale hardcoded default is worse than an explicit config
 * error. Anthropic keeps a default since claude-sonnet-5 is known-current.
 */
export function getConfiguredProvider(): TriageProvider | null {
  const providerName = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();

  switch (providerName) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      return new AnthropicTriageProvider(apiKey, process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5");
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      const model = process.env.OPENAI_MODEL;
      if (!apiKey || !model) return null;
      return new OpenAITriageProvider(apiKey, model);
    }
    case "google": {
      const apiKey = process.env.GOOGLE_API_KEY;
      const model = process.env.GOOGLE_MODEL;
      if (!apiKey || !model) return null;
      return new GoogleTriageProvider(apiKey, model);
    }
    default:
      console.warn(`[triage] unknown AI_PROVIDER "${providerName}" — triage disabled`);
      return null;
  }
}

/**
 * Ask the configured AI provider to classify why a dead-lettered job kept
 * failing, using its full attempt history, and store the result in
 * dead_letter_triage. Meant to be called after a job transitions to
 * dead_letter — fire-and-forget from the caller's perspective, so a slow or
 * failing AI call never blocks the actual retry/DLQ path that already
 * happened.
 */
export async function triageDeadLetterJob(jobId: string): Promise<void> {
  const provider = getConfiguredProvider();
  if (!provider) return; // no key/model configured for the selected provider — feature quietly off

  const job = await db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job || job.status !== "dead_letter") return;

  const attempts = await db
    .selectFrom("job_attempts")
    .select(["attempt_number", "outcome", "error_message"])
    .where("job_id", "=", jobId)
    .orderBy("attempt_number", "asc")
    .execute();

  const result = await provider.classify({
    jobType: job.job_type,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    attemptHistory: attempts.map((a) => ({
      attemptNumber: a.attempt_number,
      outcome: a.outcome,
      errorMessage: a.error_message,
    })),
  });

  await db
    .insertInto("dead_letter_triage")
    .values({
      job_id: jobId,
      classification: result.classification,
      suggested_fix: result.suggestedFix,
      confidence: result.confidence,
      model_used: result.modelUsed,
    })
    .onConflict((oc) =>
      oc.column("job_id").doUpdateSet({
        classification: sql`excluded.classification`,
        suggested_fix: sql`excluded.suggested_fix`,
        confidence: sql`excluded.confidence`,
        model_used: sql`excluded.model_used`,
        created_at: sql`now()`,
      })
    )
    .execute();
}

/** Fire-and-forget wrapper — never lets a triage failure surface to the caller. */
export function triageDeadLetterJobInBackground(jobId: string): void {
  triageDeadLetterJob(jobId).catch((err) => {
    console.error(`[triage] failed for job ${jobId}:`, err);
  });
}

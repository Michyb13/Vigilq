export interface TriageInput {
  jobType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  attemptHistory: {
    attemptNumber: number;
    outcome: string | null;
    errorMessage: string | null;
  }[];
}

export interface TriageOutput {
  classification: string;
  suggestedFix: string;
  confidence: number;
  modelUsed: string;
}

/** Every AI provider (Claude, GPT, Gemini, ...) implements this one method. */
export interface TriageProvider {
  classify(input: TriageInput): Promise<TriageOutput>;
}

export const TRIAGE_CLASSIFICATIONS = [
  "transient_network",
  "bad_payload",
  "code_bug",
  "external_dependency",
  "unknown",
] as const;

export function buildTriagePrompt(input: TriageInput): string {
  return [
    `A background job permanently failed after exhausting all retries and was moved to a dead-letter queue.`,
    ``,
    `Job type: ${input.jobType}`,
    `Payload: ${JSON.stringify(input.payload)}`,
    `Total attempts: ${input.attempts} (max allowed: ${input.maxAttempts})`,
    ``,
    `Attempt history:`,
    ...input.attemptHistory.map(
      (a) => `- Attempt ${a.attemptNumber}: ${a.outcome ?? "unknown"} — ${a.errorMessage ?? "(no error message)"}`
    ),
    ``,
    `Classify the root cause (one of: ${TRIAGE_CLASSIFICATIONS.join(", ")}) and suggest a concrete fix.`,
  ].join("\n");
}

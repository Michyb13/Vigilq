import OpenAI from "openai";
import { buildTriagePrompt, TriageInput, TriageOutput, TriageProvider } from "./types.js";

const TRIAGE_FUNCTION = {
  name: "record_triage",
  description: "Record the root-cause classification and suggested fix for a dead-lettered job.",
  parameters: {
    type: "object" as const,
    properties: {
      classification: {
        type: "string" as const,
        enum: ["transient_network", "bad_payload", "code_bug", "external_dependency", "unknown"],
      },
      suggested_fix: { type: "string" as const },
      confidence: { type: "number" as const },
    },
    required: ["classification", "suggested_fix", "confidence"],
  },
};

export class OpenAITriageProvider implements TriageProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async classify(input: TriageInput): Promise<TriageOutput> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: buildTriagePrompt(input) }],
      tools: [{ type: "function", function: TRIAGE_FUNCTION }],
      tool_choice: { type: "function", function: { name: "record_triage" } },
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
      throw new Error("OpenAI response had no function tool_call");
    }

    const result = JSON.parse(toolCall.function.arguments) as {
      classification: string;
      suggested_fix: string;
      confidence: number;
    };

    return {
      classification: result.classification,
      suggestedFix: result.suggested_fix,
      confidence: result.confidence,
      modelUsed: this.model,
    };
  }
}

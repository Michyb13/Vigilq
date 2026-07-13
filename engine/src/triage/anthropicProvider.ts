import Anthropic from "@anthropic-ai/sdk";
import { buildTriagePrompt, TriageInput, TriageOutput, TriageProvider } from "./types.js";

const TRIAGE_TOOL = {
  name: "record_triage",
  description: "Record the root-cause classification and suggested fix for a dead-lettered job.",
  input_schema: {
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

export class AnthropicTriageProvider implements TriageProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async classify(input: TriageInput): Promise<TriageOutput> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      tools: [TRIAGE_TOOL],
      tool_choice: { type: "tool", name: "record_triage" },
      messages: [{ role: "user", content: buildTriagePrompt(input) }],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) throw new Error("Anthropic response had no tool_use block");

    const result = toolUse.input as { classification: string; suggested_fix: string; confidence: number };
    return {
      classification: result.classification,
      suggestedFix: result.suggested_fix,
      confidence: result.confidence,
      modelUsed: this.model,
    };
  }
}

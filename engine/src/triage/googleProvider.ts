import {
  FunctionCallingMode,
  FunctionDeclaration,
  GoogleGenerativeAI,
  SchemaType,
} from "@google/generative-ai";
import { buildTriagePrompt, TriageInput, TriageOutput, TriageProvider } from "./types.js";

const TRIAGE_FUNCTION: FunctionDeclaration = {
  name: "record_triage",
  description: "Record the root-cause classification and suggested fix for a dead-lettered job.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      classification: {
        type: SchemaType.STRING,
        format: "enum",
        enum: ["transient_network", "bad_payload", "code_bug", "external_dependency", "unknown"],
      },
      suggested_fix: { type: SchemaType.STRING },
      confidence: { type: SchemaType.NUMBER },
    },
    required: ["classification", "suggested_fix", "confidence"],
  },
};

export class GoogleTriageProvider implements TriageProvider {
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async classify(input: TriageInput): Promise<TriageOutput> {
    const generativeModel = this.client.getGenerativeModel({
      model: this.model,
      tools: [{ functionDeclarations: [TRIAGE_FUNCTION] }],
      // Force the model to call record_triage rather than just replying in
      // prose — same intent as Anthropic's tool_choice / OpenAI's
      // tool_choice, Gemini's equivalent is toolConfig's ANY mode.
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingMode.ANY, allowedFunctionNames: ["record_triage"] },
      },
    });

    const result = await generativeModel.generateContent(buildTriagePrompt(input));
    const call = result.response.functionCalls()?.[0];
    if (!call) throw new Error("Gemini response had no function call");

    const args = call.args as { classification: string; suggested_fix: string; confidence: number };
    return {
      classification: args.classification,
      suggestedFix: args.suggested_fix,
      confidence: args.confidence,
      modelUsed: this.model,
    };
  }
}

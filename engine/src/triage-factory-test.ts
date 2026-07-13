import assert from "node:assert/strict";
import { getConfiguredProvider } from "./triage/index.js";
import { AnthropicTriageProvider } from "./triage/anthropicProvider.js";
import { OpenAITriageProvider } from "./triage/openaiProvider.js";
import { GoogleTriageProvider } from "./triage/googleProvider.js";

function run(name: string, fn: () => void) {
  fn();
  console.log(`PASS: ${name}`);
}

// Default provider (anthropic), no key set -> null
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
run("anthropic with no key returns null", () => {
  assert.equal(getConfiguredProvider(), null);
});

// Anthropic with a key -> real provider instance, using the default model
process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-construction-test";
run("anthropic with a key returns an AnthropicTriageProvider", () => {
  const provider = getConfiguredProvider();
  assert.ok(provider instanceof AnthropicTriageProvider);
});
delete process.env.ANTHROPIC_API_KEY;

// OpenAI selected but no key -> null
process.env.AI_PROVIDER = "openai";
run("openai with no key returns null", () => {
  assert.equal(getConfiguredProvider(), null);
});

// OpenAI with key but no model -> still null (model has no guessed default)
process.env.OPENAI_API_KEY = "sk-fake";
run("openai with key but no model returns null", () => {
  assert.equal(getConfiguredProvider(), null);
});

// OpenAI with key and model -> real provider instance
process.env.OPENAI_MODEL = "gpt-test-model";
run("openai with key and model returns an OpenAITriageProvider", () => {
  const provider = getConfiguredProvider();
  assert.ok(provider instanceof OpenAITriageProvider);
});
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;

// Google selected, key + model -> real provider instance
process.env.AI_PROVIDER = "google";
process.env.GOOGLE_API_KEY = "fake-key";
process.env.GOOGLE_MODEL = "gemini-test-model";
run("google with key and model returns a GoogleTriageProvider", () => {
  const provider = getConfiguredProvider();
  assert.ok(provider instanceof GoogleTriageProvider);
});
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_MODEL;

// Unknown provider name -> null, not a crash
process.env.AI_PROVIDER = "some-made-up-provider";
run("unknown AI_PROVIDER value returns null instead of throwing", () => {
  assert.equal(getConfiguredProvider(), null);
});

console.log("\nAll triage factory tests passed.");

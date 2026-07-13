import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { PoolConfig } from "./decision.js";

export interface AutoscalerConfig {
  engineUrl: string;
  apiKey: string;
  composeFile: string;
  pollIntervalSeconds: number;
  pools: Record<string, PoolConfig>;
}

/**
 * Loads pool bounds/thresholds from a YAML file (see pools.config.example.yaml).
 * This deliberately lives in a plain file rather than the engine's
 * pool_autoscale_config table for v1 — the autoscaler only ever talks to
 * the engine over its public HTTP API (matching plan.md's "engine just
 * exposes queue depth; the autoscaler is the only thing that calls it"),
 * never touching Postgres directly.
 */
export function loadConfig(path: string): AutoscalerConfig {
  const raw = parse(readFileSync(path, "utf8"));

  if (!raw.engineUrl || !raw.apiKey || !raw.pools) {
    throw new Error(`Invalid autoscaler config at ${path}: missing engineUrl, apiKey, or pools`);
  }

  return {
    engineUrl: String(raw.engineUrl).replace(/\/$/, ""),
    apiKey: String(raw.apiKey),
    composeFile: raw.composeFile ?? "./docker-compose.yml",
    pollIntervalSeconds: raw.pollIntervalSeconds ?? 30,
    pools: raw.pools,
  };
}

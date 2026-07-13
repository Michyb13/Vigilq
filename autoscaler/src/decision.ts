export interface PoolConfig {
  dockerService: string;
  minWorkers: number;
  maxWorkers: number;
  scaleUpThreshold: number; // pending jobs before adding a replica
  scaleDownIdleMinutes: number; // consecutive idle minutes before removing one
}

export interface DecisionInput {
  pendingCount: number;
  currentReplicas: number;
  idleMinutes: number; // how long pendingCount has been 0, tracked by the caller
  config: PoolConfig;
}

/**
 * Pure decision function — no I/O, no Docker, no HTTP. Given the current
 * state of one pool, returns the replica count it should move to next.
 * Kept separate from anything that talks to Docker/the engine so the
 * actual scaling logic can be tested in isolation, without needing a real
 * container runtime running.
 *
 * Scales by exactly one replica per tick in either direction — deliberately
 * conservative, since jumping straight to a computed "ideal" count based on
 * a single depth reading is how you get flapping (scale to 8, queue drains
 * because those workers are now running, scale back to 1, repeat).
 */
export function computeDesiredReplicas(input: DecisionInput): number {
  const { pendingCount, currentReplicas, idleMinutes, config } = input;
  const { minWorkers, maxWorkers, scaleUpThreshold, scaleDownIdleMinutes } = config;

  if (pendingCount >= scaleUpThreshold && currentReplicas < maxWorkers) {
    return currentReplicas + 1;
  }

  if (pendingCount === 0 && idleMinutes >= scaleDownIdleMinutes && currentReplicas > minWorkers) {
    return currentReplicas - 1;
  }

  // No change warranted — but always clamp to the configured bounds, in
  // case the bounds themselves changed since the last tick (e.g. someone
  // edited the config and lowered maxWorkers below the current count).
  return Math.min(Math.max(currentReplicas, minWorkers), maxWorkers);
}

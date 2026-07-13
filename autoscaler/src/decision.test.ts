import assert from "node:assert/strict";
import { computeDesiredReplicas, PoolConfig } from "./decision.js";

const config: PoolConfig = {
  dockerService: "worker-standard",
  minWorkers: 2,
  maxWorkers: 10,
  scaleUpThreshold: 5,
  scaleDownIdleMinutes: 10,
};

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

run("scales up by one when pending >= threshold and under max", () => {
  const result = computeDesiredReplicas({ pendingCount: 6, currentReplicas: 3, idleMinutes: 0, config });
  assert.equal(result, 4);
});

run("does not scale up past maxWorkers", () => {
  const result = computeDesiredReplicas({ pendingCount: 100, currentReplicas: 10, idleMinutes: 0, config });
  assert.equal(result, 10);
});

run("scales down by one when idle long enough and above min", () => {
  const result = computeDesiredReplicas({ pendingCount: 0, currentReplicas: 5, idleMinutes: 15, config });
  assert.equal(result, 4);
});

run("does not scale down below minWorkers", () => {
  const result = computeDesiredReplicas({ pendingCount: 0, currentReplicas: 2, idleMinutes: 999, config });
  assert.equal(result, 2);
});

run("does not scale down before idle threshold is reached", () => {
  const result = computeDesiredReplicas({ pendingCount: 0, currentReplicas: 5, idleMinutes: 3, config });
  assert.equal(result, 5);
});

run("does nothing when pending is below threshold and not idle", () => {
  const result = computeDesiredReplicas({ pendingCount: 2, currentReplicas: 4, idleMinutes: 0, config });
  assert.equal(result, 4);
});

run("scale-up takes priority over scale-down in the same tick", () => {
  // pathological input: pending is high AND idleMinutes is also high (shouldn't happen in
  // practice since pendingCount>0 resets idle tracking, but the function must still be safe)
  const result = computeDesiredReplicas({ pendingCount: 6, currentReplicas: 3, idleMinutes: 20, config });
  assert.equal(result, 4);
});

run("clamps down immediately if currentReplicas is already above maxWorkers (e.g. config changed)", () => {
  const result = computeDesiredReplicas({
    pendingCount: 0,
    currentReplicas: 15,
    idleMinutes: 0,
    config: { ...config, maxWorkers: 10 },
  });
  assert.equal(result, 10);
});

run("clamps up immediately if currentReplicas is already below minWorkers (e.g. config changed)", () => {
  const result = computeDesiredReplicas({
    pendingCount: 0,
    currentReplicas: 0,
    idleMinutes: 0,
    config: { ...config, minWorkers: 2 },
  });
  assert.equal(result, 2);
});

console.log("\nAll decision.ts tests passed.");

import assert from "node:assert/strict";
import { pendingCountForPool, PoolDepth } from "./engineClient.js";

const depths: PoolDepth[] = [
  { pool: null, pending_count: "7" },
  { pool: "standard", pending_count: "12" },
];

const standardCount = pendingCountForPool(depths, "standard");
assert.equal(standardCount, 12);
assert.equal(typeof standardCount, "number"); // proves the BIGINT-as-string is actually converted, not just coincidentally correct

const missingCount = pendingCountForPool(depths, "does-not-exist");
assert.equal(missingCount, 0);

console.log("PASS: pendingCountForPool converts string BIGINT to number correctly");

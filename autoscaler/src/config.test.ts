import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const config = loadConfig("./pools.config.example.yaml");

assert.equal(config.engineUrl, "http://localhost:4000");
assert.equal(config.pollIntervalSeconds, 30);
assert.ok(config.pools.standard);
assert.equal(config.pools.standard.minWorkers, 2);
assert.equal(config.pools["gpu-large"].minWorkers, 0);

console.log("PASS: loadConfig correctly parses pools.config.example.yaml");

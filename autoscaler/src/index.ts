import { loadConfig } from "./config.js";
import { fetchPoolDepths, pendingCountForPool } from "./engineClient.js";
import { getCurrentReplicaCount, scaleService } from "./dockerScaler.js";
import { computeDesiredReplicas } from "./decision.js";

const CONFIG_PATH = process.env.AUTOSCALER_CONFIG_PATH ?? "./pools.config.yaml";

// How long each pool has had zero pending jobs, in milliseconds since first
// observed idle. Reset to null the moment pendingCount is > 0 again.
const idleSince = new Map<string, number | null>();

async function tick(config: Awaited<ReturnType<typeof loadConfig>>) {
  const depths = await fetchPoolDepths(config.engineUrl, config.apiKey);

  for (const [poolName, poolConfig] of Object.entries(config.pools)) {
    const pendingCount = pendingCountForPool(depths, poolName);

    if (pendingCount > 0) {
      idleSince.set(poolName, null);
    } else if (idleSince.get(poolName) == null) {
      idleSince.set(poolName, Date.now());
    }

    const idleStart = idleSince.get(poolName);
    const idleMinutes = idleStart ? (Date.now() - idleStart) / 60_000 : 0;

    const currentReplicas = await getCurrentReplicaCount(config.composeFile, poolConfig.dockerService);
    const desiredReplicas = computeDesiredReplicas({
      pendingCount,
      currentReplicas,
      idleMinutes,
      config: poolConfig,
    });

    if (desiredReplicas !== currentReplicas) {
      console.log(
        `[autoscaler] ${poolName}: pending=${pendingCount} current=${currentReplicas} -> scaling to ${desiredReplicas}`
      );
      await scaleService(config.composeFile, poolConfig.dockerService, desiredReplicas);
    }
  }
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  console.log(
    `[autoscaler] starting — engine=${config.engineUrl} poll every ${config.pollIntervalSeconds}s, pools: ${Object.keys(config.pools).join(", ")}`
  );

  const loop = async () => {
    try {
      await tick(config);
    } catch (err) {
      console.error("[autoscaler] tick failed:", err);
    }
  };

  await loop();
  setInterval(loop, config.pollIntervalSeconds * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

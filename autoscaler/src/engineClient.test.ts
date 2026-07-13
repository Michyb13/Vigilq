import { fetchPoolDepths, pendingCountForPool } from "./engineClient.js";

async function main() {
  const baseUrl = process.env.ENGINE_URL ?? "http://localhost:4000";
  const apiKey = process.env.QUEUE_API_KEY ?? "";

  const depths = await fetchPoolDepths(baseUrl, apiKey);
  console.log("raw depths from engine:", depths);
  console.log("pendingCountForPool(null-pool):", pendingCountForPool(depths, "does-not-exist"));

  for (const d of depths) {
    console.log(`pool=${d.pool ?? "(unassigned)"} pending_count type=${typeof d.pending_count} value=${d.pending_count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

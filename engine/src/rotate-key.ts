import "dotenv/config";
import { rotateDefaultApiKey } from "./apiKey.js";
import { db } from "./db.js";

async function main() {
  const rawKey = await rotateDefaultApiKey();
  console.log("Old key(s) revoked. New API key:");
  console.log(rawKey);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

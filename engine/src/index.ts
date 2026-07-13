import "dotenv/config";
import { buildServer } from "./server.js";
import { ensureDefaultApiKey } from "./apiKey.js";
import { waitForDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";

async function main() {
  await waitForDatabase();
  await runMigrations();
  await ensureDefaultApiKey();

  const app = buildServer();
  const port = Number(process.env.PORT ?? 4000);

  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

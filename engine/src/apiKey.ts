import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "./db.js";
import { getDefaultTenantId } from "./tenant.js";

const KEY_FILE_PATH = process.env.API_KEY_FILE_PATH ?? "./data/api_key.txt";

function generateRawKey(): string {
  return `qk_live_${randomBytes(24).toString("hex")}`;
}

/** Only the hash ever touches Postgres — the raw key is unrecoverable once created. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function verifyApiKey(rawKey: string): Promise<{ tenantId: string } | null> {
  const hash = hashApiKey(rawKey);
  const row = await db
    .selectFrom("api_keys")
    .select(["tenant_id"])
    .where("key_hash", "=", hash)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

  return row ? { tenantId: row.tenant_id } : null;
}

async function persistKeyToFile(rawKey: string) {
  await mkdir(dirname(KEY_FILE_PATH), { recursive: true });
  await writeFile(
    KEY_FILE_PATH,
    `${rawKey}\n\nThis is your queue API key — put it in QUEUE_API_KEY wherever\nyou use the SDK. It is stored only as a hash in the database, so this\nfile is the only place it can be recovered from after creation.\n`,
    { mode: 0o600 }
  );
}

/**
 * Idempotent: does nothing if the default tenant already has a non-revoked
 * key (this is what makes `docker compose up` safe to run repeatedly —
 * restarts never mint a surprise second key, only the true first boot does,
 * when api_keys is empty).
 */
export async function ensureDefaultApiKey(): Promise<void> {
  const tenantId = await getDefaultTenantId();

  const existing = await db
    .selectFrom("api_keys")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

  if (existing) return;

  const rawKey = generateRawKey();
  await db
    .insertInto("api_keys")
    .values({ tenant_id: tenantId, key_hash: hashApiKey(rawKey) })
    .execute();

  await persistKeyToFile(rawKey);

  console.log("============================================================");
  console.log("API key generated (first boot only):");
  console.log(rawKey);
  console.log(`Also saved to ${KEY_FILE_PATH} — this is the only time it's shown.`);
  console.log("============================================================");
}

/** Revokes any existing key(s) for the default tenant and mints a fresh one. Use if the original is lost. */
export async function rotateDefaultApiKey(): Promise<string> {
  const tenantId = await getDefaultTenantId();

  await db
    .updateTable("api_keys")
    .set({ revoked_at: new Date() })
    .where("tenant_id", "=", tenantId)
    .where("revoked_at", "is", null)
    .execute();

  const rawKey = generateRawKey();
  await db
    .insertInto("api_keys")
    .values({ tenant_id: tenantId, key_hash: hashApiKey(rawKey) })
    .execute();

  await persistKeyToFile(rawKey);
  return rawKey;
}

import { db } from "./db.js";

/**
 * Self-host has exactly one tenant. Rather than a separate seed migration
 * right now, this lazily creates it on first use so the demo/dev flow works
 * without extra setup steps.
 */
export async function getDefaultTenantId(): Promise<string> {
  const existing = await db
    .selectFrom("tenants")
    .select("id")
    .orderBy("created_at", "asc")
    .limit(1)
    .executeTakeFirst();

  if (existing) return existing.id;

  const created = await db
    .insertInto("tenants")
    .values({ name: "default" })
    .returning("id")
    .executeTakeFirstOrThrow();

  return created.id;
}

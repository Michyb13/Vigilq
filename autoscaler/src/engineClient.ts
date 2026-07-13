export interface PoolDepth {
  pool: string | null;
  pending_count: string; // BIGINT from Postgres -> pg returns it as a string
}

/** Fetches current pending-job counts per pool from the engine's REST API. */
export async function fetchPoolDepths(baseUrl: string, apiKey: string): Promise<PoolDepth[]> {
  const res = await fetch(`${baseUrl}/pools/depths`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch pool depths (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { depths: PoolDepth[] };
  return data.depths;
}

/** Convenience lookup — depths come back as one row per pool (or one row with pool=null for unassigned jobs). */
export function pendingCountForPool(depths: PoolDepth[], pool: string): number {
  const row = depths.find((d) => d.pool === pool);
  return row ? Number(row.pending_count) : 0;
}

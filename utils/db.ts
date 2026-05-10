import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

// Prefer DATABASE_URL when set (works for compose / Vercel / cloud postgres);
// fall back to individual DB_* fields for backward-compat with older dev setups.
export function getPool(): Pool {
  if (!global.__pgPool) {
    const url = process.env.DATABASE_URL;
    global.__pgPool = url
      ? new Pool({ connectionString: url, max: 5 })
      : new Pool({
          host:     process.env.DB_HOST     ?? "localhost",
          port:     Number(process.env.DB_PORT ?? 5432),
          user:     process.env.DB_USER     ?? "n8n",
          password: process.env.DB_PASSWORD ?? "n8n_pass",
          database: process.env.DB_NAME     ?? "n8n",
          max: 5,
        });
  }
  return global.__pgPool;
}

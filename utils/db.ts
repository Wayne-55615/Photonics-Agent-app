import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!global.__pgPool) {
    global.__pgPool = new Pool({
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

/**
 * Tiny SQL layer with two interchangeable drivers that speak the SAME dialect (Postgres):
 *  - node-postgres (`pg`) when DATABASE_URL starts with postgres:// or postgresql://
 *  - PGlite (Postgres compiled to WASM, embedded, zero native deps) otherwise — local dev/tests.
 * One migration set, window functions, ON CONFLICT, JSONB etc. behave identically.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  kind: "postgres" | "pglite";
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function openPg(url: string): Promise<Db> {
  const pg = (await import("pg")).default;
  // NUMERIC / BIGINT → string (default); keep that — callers cast explicitly.
  const needsSsl = /sslmode=require|neon\.tech|supabase\.co/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  return {
    kind: "postgres",
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q: Queryable = {
          async query(sql, params) {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows };
          },
        };
        const out = await fn(q);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(spec: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // "memory" | "pglite" | "pglite:memory" → in-memory; "pglite:<dir>" → on-disk dir
  let dataDir: string | undefined;
  const m = /^pglite:(.+)$/.exec(spec);
  if (m && m[1] !== "memory") {
    dataDir = path.resolve(m[1]);
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  const wrap = (x: { query: typeof db.query }): Queryable => ({
    async query(sql, params) {
      const r = await x.query(sql, params as unknown[]);
      return { rows: r.rows as never[] };
    },
  });
  return {
    kind: "pglite",
    ...wrap(db),
    async exec(sql) {
      await db.exec(sql);
    },
    async tx(fn) {
      return db.transaction(async (t) => fn(wrap(t as unknown as { query: typeof db.query })));
    },
    async close() {
      await db.close();
    },
  };
}

export async function openDb(databaseUrl: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//i.test(databaseUrl)) return openPg(databaseUrl);
  return openPglite(databaseUrl);
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);

/** Apply migrations/*.sql in lexical order, tracked in schema_migrations. Idempotent. */
export async function migrate(db: Db, dir = process.env.MIGRATIONS_DIR || MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      [f]
    );
    if (rows.length) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`);
    applied.push(f);
  }
  return applied;
}

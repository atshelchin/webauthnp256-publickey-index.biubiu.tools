import { assertEquals, assert } from "@std/assert/";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, LATEST_SCHEMA_VERSION, type SqlRunner } from "../../shared/migrations.ts";

function runner(db: DatabaseSync): SqlRunner {
  return {
    // deno-lint-ignore require-await
    async run(sql, params) {
      if (params && params.length > 0) db.prepare(sql).run(...(params as (string | number)[]));
      else db.exec(sql);
    },
    // deno-lint-ignore require-await
    async scalar(sql) {
      const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const v = Object.values(row)[0];
      return v == null ? undefined : Number(v);
    },
  };
}

Deno.test("runMigrations brings a fresh DB to the latest version idempotently", async () => {
  const db = new DatabaseSync(":memory:");
  const v1 = await runMigrations(runner(db), Date.now());
  assertEquals(v1, LATEST_SCHEMA_VERSION);
  // Second run is a no-op and must not throw (INSERT OR IGNORE + idempotent DDL).
  const v2 = await runMigrations(runner(db), Date.now());
  assertEquals(v2, LATEST_SCHEMA_VERSION);
  // pending_txs (v2) and its attempts column exist.
  db.prepare("INSERT INTO pending_txs (role, nonce, hash, sentAt, attempts) VALUES ('create', 1, '0x', 1, 0)").run();
  const row = db.prepare("SELECT attempts FROM pending_txs WHERE nonce = 1").get() as { attempts: number };
  assertEquals(row.attempts, 0);
});

Deno.test("runMigrations upgrades a LEGACY pre-versioning DB (has tables, no schema_migrations)", async () => {
  const db = new DatabaseSync(":memory:");
  // Simulate an old production DB: create_queue with duplicate ACTIVE rows and
  // NO schema_migrations table — the baseline must dedupe, build the index, and
  // record version without choking on the pre-existing shape.
  db.exec(`CREATE TABLE create_queue (
    id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', rpId TEXT NOT NULL,
    credentialId TEXT NOT NULL, walletRef TEXT NOT NULL DEFAULT '', publicKey TEXT NOT NULL,
    name TEXT NOT NULL, initialCredentialId TEXT NOT NULL, metadata TEXT NOT NULL,
    txHash TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', retries INTEGER NOT NULL DEFAULT 0,
    retryAfter INTEGER NOT NULL DEFAULT 0, ip TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
  const now = Date.now();
  db.prepare("INSERT INTO create_queue (id,status,rpId,credentialId,walletRef,publicKey,name,initialCredentialId,metadata,createdAt,updatedAt) VALUES ('a','pending','s','c','0x','04','n','c','0x',?,?)").run(now - 1000, now);
  db.prepare("INSERT INTO create_queue (id,status,rpId,credentialId,walletRef,publicKey,name,initialCredentialId,metadata,createdAt,updatedAt) VALUES ('b','pending','s','c','0x','04','n','c','0x',?,?)").run(now, now);

  const v = await runMigrations(runner(db), now);
  assertEquals(v, LATEST_SCHEMA_VERSION);
  // Exactly one active row survives per (rpId,credentialId); the other demoted.
  const active = db.prepare("SELECT COUNT(*) c FROM create_queue WHERE status != 'failed'").get() as { c: number };
  assertEquals(active.c, 1, "duplicate active rows collapsed by the baseline dedupe");
  // Re-running against the now-migrated DB is a clean no-op.
  const again = await runMigrations(runner(db), now);
  assertEquals(again, LATEST_SCHEMA_VERSION);
  assert(true);
});

import { assertEquals, assert } from "@std/assert/";
import { initQueue, enqueue, findDuplicate, getQueueDb } from "../queue.ts";

function setup() {
  initQueue(":memory:");
}

const base = {
  walletRef: "0x" + "ab".repeat(32),
  publicKey: "04" + "aa".repeat(64),
  name: "k",
  metadata: "0x00",
  ip: "127.0.0.1",
};

function activeCount(rpId: string, credentialId: string): number {
  return (getQueueDb().prepare(
    "SELECT COUNT(*) as c FROM create_queue WHERE rpId = ? AND credentialId = ? AND status != 'failed'",
  ).get(rpId, credentialId) as unknown as { c: number }).c;
}

Deno.test("enqueue is idempotent: concurrent identical creates return one job", async () => {
  setup();
  const p = { rpId: "ex.com", credentialId: "c1", initialCredentialId: "c1", ...base };
  const [id1, id2] = await Promise.all([enqueue(p), enqueue(p)]);
  assertEquals(id1, id2, "both creates must resolve to the same queue id");
  assertEquals(activeCount("ex.com", "c1"), 1, "exactly one active row, not a duplicate");
});

Deno.test("enqueue: a second create for the same key returns the existing job", async () => {
  setup();
  const p = { rpId: "ex.com", credentialId: "c2", initialCredentialId: "c2", ...base };
  const id1 = await enqueue(p);
  const id2 = await enqueue(p);
  assertEquals(id1, id2);
  assertEquals(activeCount("ex.com", "c2"), 1);
});

Deno.test("enqueue: distinct credentials create distinct active rows", async () => {
  setup();
  const id1 = await enqueue({ rpId: "ex.com", credentialId: "a", initialCredentialId: "a", ...base });
  const id2 = await enqueue({ rpId: "ex.com", credentialId: "b", initialCredentialId: "b", ...base });
  assert(id1 !== id2);
  assertEquals(activeCount("ex.com", "a"), 1);
  assertEquals(activeCount("ex.com", "b"), 1);
});

Deno.test("enqueue: re-create is allowed after the prior job is 'failed' (DLQ)", async () => {
  setup();
  const p = { rpId: "ex.com", credentialId: "c3", initialCredentialId: "c3", ...base };
  const id1 = await enqueue(p);
  // Move the first job to the DLQ.
  getQueueDb().prepare("UPDATE create_queue SET status = 'failed' WHERE id = ?").run(id1);
  // A fresh create must be accepted (new active row, different id).
  const id2 = await enqueue(p);
  assert(id1 !== id2, "re-create after failure should produce a new job");
  assertEquals(activeCount("ex.com", "c3"), 1, "only the new attempt is active");
  const newest = findDuplicate("ex.com", "c3");
  assertEquals(newest!.id, id2);
  assertEquals(newest!.status, "pending");
});

Deno.test("migration dedupe: pre-existing active duplicates are collapsed to one on init", () => {
  // Build a table WITHOUT the unique index, insert duplicate active rows, then
  // re-run initQueue (which dedupes + builds the index) and assert convergence.
  initQueue(":memory:");
  const db = getQueueDb();
  // Drop the unique index so we can insert duplicates the old (buggy) way.
  db.exec("DROP INDEX IF EXISTS idx_queue_active_unique");
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.prepare(
      "INSERT INTO create_queue (id, status, rpId, credentialId, walletRef, publicKey, name, initialCredentialId, metadata, ip, createdAt, updatedAt) VALUES (?, 'pending', 'dup.com', 'cc', '', '04', 'k', 'cc', '0x', '', ?, ?)",
    ).run(`dup-${i}`, now + i, now + i);
  }
  assertEquals(activeCount("dup.com", "cc"), 3, "precondition: 3 active duplicates");

  // Re-run migration: dedupe (keep newest) then rebuild unique index.
  db.prepare(
    `UPDATE create_queue SET status = 'failed', error = 'superseded-duplicate', updatedAt = ?
     WHERE status != 'failed' AND EXISTS (
       SELECT 1 FROM create_queue n WHERE n.rpId = create_queue.rpId AND n.credentialId = create_queue.credentialId
         AND n.status != 'failed' AND (n.createdAt > create_queue.createdAt OR (n.createdAt = create_queue.createdAt AND n.id > create_queue.id)))`,
  ).run(Date.now());
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_unique ON create_queue(rpId, credentialId) WHERE status != 'failed'");

  assertEquals(activeCount("dup.com", "cc"), 1, "exactly one active row survives");
  const survivor = findDuplicate("dup.com", "cc");
  assertEquals(survivor!.id, "dup-2", "the newest (highest createdAt) survives");
});

Deno.test("migration dedupe: a 'done' row is NEVER demoted in favor of a newer active duplicate", () => {
  initQueue(":memory:");
  const db = getQueueDb();
  db.exec("DROP INDEX IF EXISTS idx_queue_active_unique");
  const now = Date.now();
  // Older 'done' (already on-chain success) + newer 'pending' duplicate.
  db.prepare("INSERT INTO create_queue (id, status, rpId, credentialId, walletRef, publicKey, name, initialCredentialId, metadata, ip, createdAt, updatedAt) VALUES ('old-done', 'done', 'd.com', 'k', '', '04', 'n', 'k', '0x', '', ?, ?)").run(now, now);
  db.prepare("INSERT INTO create_queue (id, status, rpId, credentialId, walletRef, publicKey, name, initialCredentialId, metadata, ip, createdAt, updatedAt) VALUES ('new-pending', 'pending', 'd.com', 'k', '', '04', 'n', 'k', '0x', '', ?, ?)").run(now + 1000, now + 1000);

  db.prepare(
    `UPDATE create_queue SET status = 'failed', error = 'superseded-duplicate', updatedAt = ?
     WHERE status != 'failed' AND EXISTS (
       SELECT 1 FROM create_queue n WHERE n.rpId = create_queue.rpId AND n.credentialId = create_queue.credentialId
         AND n.status != 'failed' AND n.id != create_queue.id
         AND ((n.status='done') > (create_queue.status='done')
           OR ((n.status='done') = (create_queue.status='done') AND (n.createdAt > create_queue.createdAt OR (n.createdAt = create_queue.createdAt AND n.id > create_queue.id)))))`,
  ).run(Date.now());
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_unique ON create_queue(rpId, credentialId) WHERE status != 'failed'");

  const survivor = findDuplicate("d.com", "k");
  assertEquals(survivor!.id, "old-done", "the 'done' success must survive over a newer pending dup");
  assertEquals(survivor!.status, "done");
  assertEquals(activeCount("d.com", "k"), 1);
});

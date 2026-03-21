import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, setDb, getDb, getPublicKey, createPublicKey, listRpIds, listPublicKeysByRpId, backupToFile, mergeFromBackup } from "./db.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = ":memory:";
const BACKUP_PATH = "./test-backup.db";

beforeEach(() => {
  initDb(TEST_DB);
});

afterEach(() => {
  if (existsSync(BACKUP_PATH)) unlinkSync(BACKUP_PATH);
});

// --- getPublicKey ---

test("getPublicKey returns null when not found", () => {
  expect(getPublicKey("example.com", "cred1")).toBeNull();
});

test("getPublicKey returns record after creation", () => {
  createPublicKey("example.com", "cred1", "04abcdef");
  const result = getPublicKey("example.com", "cred1");
  expect(result).not.toBeNull();
  expect(result!.rpId).toBe("example.com");
  expect(result!.credentialId).toBe("cred1");
  expect(result!.publicKey).toBe("04abcdef");
  expect(result!.createdAt).toBeGreaterThan(0);
});

// --- createPublicKey ---

test("createPublicKey creates rpId record on first insert", () => {
  createPublicKey("site.com", "c1", "04aaa");
  const rps = listRpIds(1, 10);
  expect(rps.items.length).toBe(1);
  expect(rps.items[0]!.rpId).toBe("site.com");
  expect(rps.items[0]!.publicKeyCount).toBe(1);
});

test("createPublicKey increments publicKeyCount", () => {
  createPublicKey("site.com", "c1", "04aaa");
  createPublicKey("site.com", "c2", "04bbb");
  const rps = listRpIds(1, 10);
  expect(rps.items[0]!.publicKeyCount).toBe(2);
});

test("createPublicKey rejects duplicate rpId+credentialId", () => {
  createPublicKey("site.com", "c1", "04aaa");
  expect(() => createPublicKey("site.com", "c1", "04bbb")).toThrow();
});

test("createPublicKey returns the created record", () => {
  const result = createPublicKey("site.com", "c1", "04aaa");
  expect(result.rpId).toBe("site.com");
  expect(result.credentialId).toBe("c1");
  expect(result.publicKey).toBe("04aaa");
  expect(result.createdAt).toBeGreaterThan(0);
});

// --- listRpIds ---

test("listRpIds returns empty when no data", () => {
  const result = listRpIds(1, 10);
  expect(result.total).toBe(0);
  expect(result.items).toEqual([]);
});

test("listRpIds paginates correctly", () => {
  for (let i = 0; i < 5; i++) {
    createPublicKey(`site${i}.com`, "c1", `04${i}`);
  }
  const page1 = listRpIds(1, 2, "asc");
  expect(page1.total).toBe(5);
  expect(page1.items.length).toBe(2);

  const page3 = listRpIds(3, 2, "asc");
  expect(page3.items.length).toBe(1);
});

test("listRpIds sorts by time", () => {
  // Insert with explicit different timestamps via raw SQL to guarantee ordering
  const d = getDb();
  d.prepare("INSERT INTO rp_ids (rpId, publicKeyCount, createdAt) VALUES (?, 1, ?)").run("a.com", 1000);
  d.prepare("INSERT INTO rp_ids (rpId, publicKeyCount, createdAt) VALUES (?, 1, ?)").run("b.com", 2000);

  const asc = listRpIds(1, 10, "asc");
  expect(asc.items[0]!.rpId).toBe("a.com");

  const desc = listRpIds(1, 10, "desc");
  expect(desc.items[0]!.rpId).toBe("b.com");
});

// --- listPublicKeysByRpId ---

test("listPublicKeysByRpId returns empty for unknown rpId", () => {
  const result = listPublicKeysByRpId("unknown.com", 1, 10);
  expect(result.total).toBe(0);
  expect(result.items).toEqual([]);
});

test("listPublicKeysByRpId paginates correctly", () => {
  for (let i = 0; i < 5; i++) {
    createPublicKey("site.com", `c${i}`, `04${i}`);
  }
  const page1 = listPublicKeysByRpId("site.com", 1, 2);
  expect(page1.total).toBe(5);
  expect(page1.items.length).toBe(2);
});

test("listPublicKeysByRpId only returns keys for specified rpId", () => {
  createPublicKey("a.com", "c1", "04a");
  createPublicKey("b.com", "c1", "04b");
  const result = listPublicKeysByRpId("a.com", 1, 10);
  expect(result.total).toBe(1);
  expect(result.items[0]!.rpId).toBe("a.com");
});

// --- backup & merge ---

test("backupToFile creates a valid backup", () => {
  createPublicKey("site.com", "c1", "04aaa");
  backupToFile(BACKUP_PATH);
  expect(existsSync(BACKUP_PATH)).toBe(true);

  const backupDb = new Database(BACKUP_PATH, { readonly: true });
  const rows = backupDb.prepare("SELECT * FROM public_keys").all();
  expect(rows.length).toBe(1);
  backupDb.close();
});

test("mergeFromBackup imports missing records", () => {
  // Create backup with some data
  createPublicKey("site.com", "c1", "04aaa");
  backupToFile(BACKUP_PATH);

  // Reset to empty db
  initDb(TEST_DB);

  // Merge
  mergeFromBackup(BACKUP_PATH);

  const result = getPublicKey("site.com", "c1");
  expect(result).not.toBeNull();
  expect(result!.publicKey).toBe("04aaa");

  const rps = listRpIds(1, 10);
  expect(rps.items[0]!.publicKeyCount).toBe(1);
});

test("mergeFromBackup skips existing records", () => {
  createPublicKey("site.com", "c1", "04aaa");
  backupToFile(BACKUP_PATH);

  // c1 already exists, merge should not fail
  mergeFromBackup(BACKUP_PATH);

  const keys = listPublicKeysByRpId("site.com", 1, 10);
  expect(keys.total).toBe(1);
});

test("mergeFromBackup merges new + existing", () => {
  createPublicKey("site.com", "c1", "04aaa");
  backupToFile(BACKUP_PATH);

  // Reset and add different data
  initDb(TEST_DB);
  createPublicKey("site.com", "c2", "04bbb");

  // Merge backup (has c1) into current (has c2)
  mergeFromBackup(BACKUP_PATH);

  expect(getPublicKey("site.com", "c1")).not.toBeNull();
  expect(getPublicKey("site.com", "c2")).not.toBeNull();

  const rps = listRpIds(1, 10);
  expect(rps.items[0]!.publicKeyCount).toBe(2);
});

// --- Edge cases ---

test("createPublicKey with multiple rpIds keeps separate counts", () => {
  createPublicKey("a.com", "c1", "04a");
  createPublicKey("a.com", "c2", "04b");
  createPublicKey("b.com", "c1", "04c");
  const rps = listRpIds(1, 10, "asc");
  const aRp = rps.items.find((r) => r.rpId === "a.com");
  const bRp = rps.items.find((r) => r.rpId === "b.com");
  expect(aRp!.publicKeyCount).toBe(2);
  expect(bRp!.publicKeyCount).toBe(1);
});

test("listRpIds beyond last page returns empty items", () => {
  createPublicKey("a.com", "c1", "04a");
  const result = listRpIds(999, 10);
  expect(result.total).toBe(1);
  expect(result.items).toEqual([]);
});

test("listPublicKeysByRpId beyond last page returns empty items", () => {
  createPublicKey("a.com", "c1", "04a");
  const result = listPublicKeysByRpId("a.com", 999, 10);
  expect(result.total).toBe(1);
  expect(result.items).toEqual([]);
});

test("getDb returns initialized db", () => {
  const d = getDb();
  expect(d).toBeDefined();
});

test("setDb replaces the database instance", () => {
  const newDb = new Database(":memory:");
  setDb(newDb);
  expect(getDb()).toBe(newDb);
  // restore for other tests
  initDb(TEST_DB);
});

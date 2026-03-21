import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { initDb, createPublicKey, getPublicKey, listRpIds } from "../db.ts";
import { cacheClear, cacheSet, cacheGet } from "../cache.ts";
import { handleRestore } from "./maintain.ts";
import { unlinkSync, existsSync } from "node:fs";

beforeEach(() => {
  initDb(":memory:");
  cacheClear();
});

// --- handleRestore ---

test("handleRestore returns 400 for invalid JSON", async () => {
  const req = new Request("http://localhost/api/restore", {
    method: "POST",
    body: "not json",
  });
  const res = await handleRestore(req);
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error).toContain("invalid JSON");
});

test("handleRestore returns 400 when url is missing", async () => {
  const req = new Request("http://localhost/api/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const res = await handleRestore(req);
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error).toContain("url is required");
});

test("handleRestore returns error for unreachable url", async () => {
  const req = new Request("http://localhost/api/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1:1/nonexistent.db" }),
  });
  const res = await handleRestore(req);
  // Could be 400 (download failed) or 500 (network error)
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test("handleRestore merges data from a local backup file", async () => {
  // Create some data and backup
  createPublicKey("a.com", "c1", "04aaa");
  const { backupToFile } = await import("../db.ts");
  const backupPath = "./test-restore-backup.db";
  backupToFile(backupPath);

  // Reset db
  initDb(":memory:");
  createPublicKey("b.com", "c2", "04bbb");

  // Serve the backup file locally for the restore endpoint
  const backupServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(Bun.file(backupPath));
    },
  });

  try {
    const req = new Request("http://localhost/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://localhost:${backupServer.port}/backup.db` }),
    });
    const res = await handleRestore(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // Both records should exist
    expect(getPublicKey("a.com", "c1")).not.toBeNull();
    expect(getPublicKey("b.com", "c2")).not.toBeNull();
  } finally {
    backupServer.stop();
    if (existsSync(backupPath)) unlinkSync(backupPath);
  }
});

test("handleRestore clears cache after merge", async () => {
  createPublicKey("a.com", "c1", "04aaa");
  const { backupToFile } = await import("../db.ts");
  const backupPath = "./test-restore-cache.db";
  backupToFile(backupPath);

  initDb(":memory:");
  cacheSet("query:a.com:c1", { cached: true });

  const backupServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(Bun.file(backupPath));
    },
  });

  try {
    const req = new Request("http://localhost/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://localhost:${backupServer.port}/backup.db` }),
    });
    await handleRestore(req);
    expect(cacheGet("query:a.com:c1")).toBeUndefined();
  } finally {
    backupServer.stop();
    if (existsSync(backupPath)) unlinkSync(backupPath);
  }
});

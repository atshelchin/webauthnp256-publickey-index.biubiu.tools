import { Database } from "bun:sqlite";

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = initDb();
  }
  return db;
}

export function initDb(path = "data.db"): Database {
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS rp_ids (
      rpId TEXT PRIMARY KEY,
      publicKeyCount INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS public_keys (
      rpId TEXT NOT NULL REFERENCES rp_ids(rpId),
      credentialId TEXT NOT NULL,
      publicKey TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (rpId, credentialId)
    )
  `);

  return db;
}

export function setDb(newDb: Database) {
  db = newDb;
}

// --- Query ---

export function getPublicKey(rpId: string, credentialId: string) {
  const stmt = getDb().prepare(
    "SELECT rpId, credentialId, publicKey, createdAt FROM public_keys WHERE rpId = ? AND credentialId = ?"
  );
  return stmt.get(rpId, credentialId) as {
    rpId: string;
    credentialId: string;
    publicKey: string;
    createdAt: number;
  } | null;
}

// --- Create ---

export function createPublicKey(rpId: string, credentialId: string, publicKey: string): { rpId: string; credentialId: string; publicKey: string; createdAt: number } {
  const now = Date.now();
  const d = getDb();

  const existingRp = d.prepare("SELECT rpId FROM rp_ids WHERE rpId = ?").get(rpId);
  if (!existingRp) {
    d.prepare("INSERT INTO rp_ids (rpId, publicKeyCount, createdAt) VALUES (?, 0, ?)").run(rpId, now);
  }

  d.prepare(
    "INSERT INTO public_keys (rpId, credentialId, publicKey, createdAt) VALUES (?, ?, ?, ?)"
  ).run(rpId, credentialId, publicKey, now);

  d.prepare("UPDATE rp_ids SET publicKeyCount = publicKeyCount + 1 WHERE rpId = ?").run(rpId);

  return { rpId, credentialId, publicKey, createdAt: now };
}

// --- Stats ---

export function listRpIds(page: number, pageSize: number, order: "asc" | "desc" = "desc") {
  const offset = (page - 1) * pageSize;
  const total = (getDb().prepare("SELECT COUNT(*) as count FROM rp_ids").get() as { count: number }).count;
  const items = getDb()
    .prepare(`SELECT rpId, publicKeyCount, createdAt FROM rp_ids ORDER BY createdAt ${order === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`)
    .all(pageSize, offset) as { rpId: string; publicKeyCount: number; createdAt: number }[];
  return { total, page, pageSize, items };
}

export function listPublicKeysByRpId(rpId: string, page: number, pageSize: number, order: "asc" | "desc" = "desc") {
  const offset = (page - 1) * pageSize;
  const total = (getDb().prepare("SELECT COUNT(*) as count FROM public_keys WHERE rpId = ?").get(rpId) as { count: number }).count;
  const items = getDb()
    .prepare(`SELECT rpId, credentialId, publicKey, createdAt FROM public_keys WHERE rpId = ? ORDER BY createdAt ${order === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`)
    .all(rpId, pageSize, offset) as { rpId: string; credentialId: string; publicKey: string; createdAt: number }[];
  return { total, page, pageSize, items };
}

// --- Backup / Restore ---

export function backupToFile(destPath: string) {
  getDb().exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

export function mergeFromBackup(backupPath: string) {
  const backupDb = new Database(backupPath, { readonly: true });

  const rpIds = backupDb.prepare("SELECT rpId, createdAt FROM rp_ids").all() as { rpId: string; createdAt: number }[];
  const d = getDb();

  const insertRp = d.prepare("INSERT OR IGNORE INTO rp_ids (rpId, publicKeyCount, createdAt) VALUES (?, 0, ?)");
  const insertPk = d.prepare("INSERT OR IGNORE INTO public_keys (rpId, credentialId, publicKey, createdAt) VALUES (?, ?, ?, ?)");
  const updateCount = d.prepare("UPDATE rp_ids SET publicKeyCount = (SELECT COUNT(*) FROM public_keys WHERE rpId = ?) WHERE rpId = ?");

  const transaction = d.transaction(() => {
    for (const rp of rpIds) {
      insertRp.run(rp.rpId, rp.createdAt);
    }

    const publicKeys = backupDb.prepare("SELECT rpId, credentialId, publicKey, createdAt FROM public_keys").all() as {
      rpId: string; credentialId: string; publicKey: string; createdAt: number;
    }[];

    const affectedRpIds = new Set<string>();
    for (const pk of publicKeys) {
      insertPk.run(pk.rpId, pk.credentialId, pk.publicKey, pk.createdAt);
      affectedRpIds.add(pk.rpId);
    }

    for (const rpId of affectedRpIds) {
      updateCount.run(rpId, rpId);
    }
  });

  transaction();
  backupDb.close();
}

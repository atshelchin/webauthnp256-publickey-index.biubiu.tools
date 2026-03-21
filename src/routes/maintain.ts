import { S3Client } from "bun";
import { backupToFile, mergeFromBackup } from "../db.ts";
import { cacheClear } from "../cache.ts";

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: getEnv("R2_ENDPOINT"),
    accessKeyId: getEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
    bucket: getEnv("R2_BUCKET"),
  });
}

async function uploadToR2(filePath: string, key: string): Promise<string> {
  const s3 = getS3Client();
  const data = await Bun.file(filePath).arrayBuffer();
  await s3.write(key, data);
  const publicUrl = getEnv("R2_PUBLIC_URL");
  return `${publicUrl}/${key}`;
}

async function deleteFromR2(key: string): Promise<void> {
  const s3 = getS3Client();
  await s3.delete(key);
}

async function listR2Keys(prefix: string): Promise<string[]> {
  const s3 = getS3Client();
  const result = await s3.list({ prefix });
  const keys = (result.contents ?? []).map((item) => item.key);
  return keys.sort();
}

async function sendTelegramMessage(message: string): Promise<void> {
  const botToken = getEnv("TELEGRAM_BOT_TOKEN");
  const chatId = getEnv("TELEGRAM_CHAT_ID");

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
}

// --- Admin API Key ---

export function verifyAdminKey(req: Request): boolean {
  const key = req.headers.get("X-Admin-Key");
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return false;
  return key === expected;
}

// --- Backup retention ---

const HOURLY_KEEP = 24;
const DAILY_KEEP = 7;
const BACKUP_INTERVAL = 60 * 60 * 1000; // 1 hour

async function cleanupOldBackups(prefix: string, keep: number): Promise<void> {
  const keys = await listR2Keys(prefix);
  if (keys.length <= keep) return;
  const toDelete = keys.slice(0, keys.length - keep);
  for (const key of toDelete) {
    await deleteFromR2(key).catch(() => {});
  }
}

export function startAutoBackup() {
  // Run first backup shortly after start (10 seconds)
  setTimeout(() => {
    performBackup().catch((err) => console.error("[auto-backup] Initial backup failed:", err));
  }, 10_000);

  setInterval(() => {
    performBackup().catch((err) => console.error("[auto-backup] Failed:", err));
  }, BACKUP_INTERVAL);
  console.log("[auto-backup] Scheduled every 1 hour");
}

async function performBackup(): Promise<void> {
  console.log("[auto-backup] Starting scheduled backup...");
  const res = await handleBackup();
  const body = await res.json();
  if (body.success) {
    console.log(`[auto-backup] Success: ${body.url}`);
  } else {
    console.error(`[auto-backup] Failed: ${body.error}`);
  }
}

export async function handleBackup(): Promise<Response> {
  try {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const backupFileName = `backup-${timestamp}.db`;
    const backupPath = `./backups/${backupFileName}`;

    await Bun.$`mkdir -p ./backups`;
    backupToFile(backupPath);

    // Upload hourly backup
    const hourlyKey = `backups/hourly/${backupFileName}`;
    const downloadUrl = await uploadToR2(backupPath, hourlyKey);

    // Upload daily backup (one per day, keyed by date)
    const dailyKey = `backups/daily/backup-${now.toISOString().slice(0, 10)}.db`;
    await uploadToR2(backupPath, dailyKey);

    // Clean up local file
    await Bun.$`rm -f ${backupPath}`;

    // Retention: keep last 24 hourly, last 7 daily
    await cleanupOldBackups("backups/hourly/", HOURLY_KEEP).catch(() => {});
    await cleanupOldBackups("backups/daily/", DAILY_KEEP).catch(() => {});

    // Notify via Telegram
    await sendTelegramMessage(`✅ Backup completed\n📥 ${downloadUrl}`).catch(() => {});

    return Response.json({ success: true, url: downloadUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return Response.json({ error: `backup failed: ${message}` }, { status: 500 });
  }
}

export async function handleRestore(req: Request): Promise<Response> {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { url } = body;
  if (!url) {
    return Response.json({ error: "url is required" }, { status: 400 });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return Response.json({ error: `failed to download backup: ${response.status}` }, { status: 400 });
    }

    const tempPath = `./backups/restore-${Date.now()}.db`;
    await Bun.$`mkdir -p ./backups`;
    await Bun.write(tempPath, await response.arrayBuffer());

    mergeFromBackup(tempPath);
    cacheClear();

    await Bun.$`rm -f ${tempPath}`;

    return Response.json({ success: true, message: "restore completed (incremental merge)" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return Response.json({ error: `restore failed: ${message}` }, { status: 500 });
  }
}

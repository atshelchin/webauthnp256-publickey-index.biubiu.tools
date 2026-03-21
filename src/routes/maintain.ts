import { backupToFile, mergeFromBackup } from "../db.ts";
import { cacheClear } from "../cache.ts";

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

async function uploadToR2(filePath: string, key: string): Promise<string> {
  const endpoint = getEnv("R2_ENDPOINT");
  const accessKeyId = getEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = getEnv("R2_SECRET_ACCESS_KEY");
  const bucket = getEnv("R2_BUCKET");

  const file = Bun.file(filePath);
  const body = await file.arrayBuffer();
  const url = `${endpoint}/${bucket}/${key}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    },
    body,
    // @ts-expect-error Bun supports aws option for S3-compatible signing
    aws: { accessKeyId, secretAccessKey, service: "s3" },
  });

  if (!response.ok) {
    throw new Error(`R2 upload failed: ${response.status} ${await response.text()}`);
  }

  const publicUrl = getEnv("R2_PUBLIC_URL");
  return `${publicUrl}/${key}`;
}

async function deleteFromR2(key: string): Promise<void> {
  const endpoint = getEnv("R2_ENDPOINT");
  const accessKeyId = getEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = getEnv("R2_SECRET_ACCESS_KEY");
  const bucket = getEnv("R2_BUCKET");

  const url = `${endpoint}/${bucket}/${key}`;
  await fetch(url, {
    method: "DELETE",
    // @ts-expect-error Bun supports aws option
    aws: { accessKeyId, secretAccessKey, service: "s3" },
  });
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

let lastBackupKey: string | null = null;
const BACKUP_INTERVAL = 60 * 60 * 1000; // 1 hour

export function startAutoBackup() {
  setInterval(async () => {
    console.log("[auto-backup] Starting scheduled backup...");
    const res = await handleBackup();
    const body = await res.json();
    if (body.success) {
      console.log(`[auto-backup] Success: ${body.url}`);
    } else {
      console.error(`[auto-backup] Failed: ${body.error}`);
    }
  }, BACKUP_INTERVAL);
  console.log("[auto-backup] Scheduled every 1 hour");
}

export async function handleBackup(): Promise<Response> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFileName = `backup-${timestamp}.db`;
    const backupPath = `./backups/${backupFileName}`;
    const r2Key = `backups/${backupFileName}`;

    await Bun.$`mkdir -p ./backups`;
    backupToFile(backupPath);

    const downloadUrl = await uploadToR2(backupPath, r2Key);

    // Delete old backup from R2
    if (lastBackupKey && lastBackupKey !== r2Key) {
      await deleteFromR2(lastBackupKey).catch(() => {});
    }
    lastBackupKey = r2Key;

    // Clean up local backup file
    await Bun.$`rm -f ${backupPath}`;

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

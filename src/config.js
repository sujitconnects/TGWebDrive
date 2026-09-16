import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
// Allow pointing at a mounted persistent volume so the DB/session survive rebuilds & redeploys.
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const UPLOAD_TMP = path.join(DATA_DIR, "uploads");
// Where in-flight upload temp files/parts are written. Defaults to a persistent
// location under DATA_DIR (not /tmp) so container tmpfs limits and restarts
// don't silently lose or corrupt uploads in progress.
export const UPLOAD_TMP_DIR = process.env.UPLOAD_TMP_DIR ? path.resolve(process.env.UPLOAD_TMP_DIR) : UPLOAD_TMP;

for (const d of [DATA_DIR, UPLOAD_TMP, UPLOAD_TMP_DIR]) fs.mkdirSync(d, { recursive: true });

function readSecret() {
  const envFile = path.join(ROOT, ".env");
  if (process.env.SECRET && process.env.SECRET.length >= 32) return process.env.SECRET;
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^SECRET=(.+)$/);
      if (m && m[1].trim().length >= 32) return m[1].trim();
    }
  }
  const generated = randomBytes(32).toString("hex");
  const extra = process.env.SECRET ? `\n` : `\n`;
  const block = `SECRET=${generated}\n`;
  if (fs.existsSync(envFile)) {
    let txt = fs.readFileSync(envFile, "utf8");
    if (/^SECRET=/.test(txt)) txt = txt.replace(/^SECRET=.*$/m, `SECRET=${generated}`);
    else txt = txt.replace(/\s*$/, "") + "\n" + block;
    fs.writeFileSync(envFile, txt);
  } else {
    fs.writeFileSync(envFile, block);
  }
  process.env.SECRET = generated;
  return generated;
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || "127.0.0.1",
  secret: readSecret(),
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024,
  // Temp directory for in-flight uploads (see UPLOAD_TMP_DIR above) and how long an
  // abandoned upload dir may sit before the startup sweep removes it.
  uploadTmpDir: UPLOAD_TMP_DIR,
  uploadTmpMaxAgeHours: Number(process.env.UPLOAD_TMP_MAX_AGE_HOURS) || 24,
  // Keep large uploads in smaller Telegram transfers so a connection reset does
  // not lose an entire multi-gigabyte upload. Parts reassemble on download.
  splitPartBytes: Number(process.env.SPLIT_PART_BYTES) || 512 * 1024 * 1024,
  // Retry tuning for transient Telegram/network failures during upload (see src/tg/retry.js).
  telegramUploadMaxAttempts: Number(process.env.TELEGRAM_UPLOAD_MAX_ATTEMPTS) || 5,
  telegramUploadRetryBaseMs: Number(process.env.TELEGRAM_UPLOAD_RETRY_BASE_MS) || 1000,
  telegramUploadRetryMaxMs: Number(process.env.TELEGRAM_UPLOAD_RETRY_MAX_MS) || 30000,
  telegramUploadMaxFloodWaitSeconds: Number(process.env.TELEGRAM_UPLOAD_MAX_FLOOD_WAIT_SECONDS) || 300,
  // How long finished (completed/failed/cancelled) upload_jobs rows are kept before
  // the startup sweep deletes them — bounded cleanup, no background worker needed.
  uploadJobRetentionDays: Number(process.env.UPLOAD_JOB_RETENTION_DAYS) || 30,
  apiPresets: (process.env.API_PRESETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, hash] = s.split(":");
      return { id: id.trim(), hash: hash.trim() };
    }),
  isProd: process.env.NODE_ENV === "production",
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === "true",
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required (Postgres connection string) — set it in .env");
}

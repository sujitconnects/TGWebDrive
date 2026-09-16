import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stmt } from "../db.js";
import { config } from "../config.js";
import { requireAppAuth, requireAdmin } from "../middleware.js";
import { getConnectedClient, HttpError } from "../tg/manager.js";
import {
  buildPeer,
  listMessages,
  getOne,
  serializeMessage,
  uploadFile,
  deleteFiles,
  streamToResponse,
} from "../tg/operations.js";
import { tempPath, safeFilename, uid, token, checkDeclaredUploadSize, wouldExceedUploadLimit, cleanupPath, fmtBytes } from "../util.js";
import { isUploadJobCancelRequested, clearUploadJobCancel } from "../uploadJobCancel.js";
import { shouldPersistUploadProgress } from "../uploadJobPolicy.js";
import { hasDuplicateNameSize } from "../duplicate.js";

export const api = Router();
export const keys = Router();

function hashKey(plain) {
  return createHash("sha256").update(plain).digest("hex");
}

export async function requireApiKey(req, res, next) {
  try {
    const key = req.headers["x-api-key"];
    if (!key) return res.status(401).json({ error: "Missing X-API-Key header" });
    const row = await stmt.findApiKeyByHash(hashKey(key));
    if (!row) return res.status(401).json({ error: "Invalid API key" });
    req.accountId = row.account_id;
    req.apiKeyId = row.id;
    next();
  } catch (e) {
    next(e);
  }
}

async function loadFolder(req) {
  const folderId = req.query.folder;
  if (!folderId) throw new HttpError(400, "Missing folder");
  const row = await stmt.getFolder(folderId, req.accountId);
  if (!row) throw new HttpError(404, "Folder not found");
  return { row, peer: buildPeer(row) };
}

api.get("/v1/folders", requireApiKey, async (req, res, next) => {
  try {
    res.json({ folders: (await stmt.foldersFor(req.accountId)).map((f) => ({ id: f.id, title: f.title, kind: f.kind })) });
  } catch (e) {
    next(e);
  }
});

api.get("/v1/files", requireApiKey, async (req, res, next) => {
  try {
    const { peer } = await loadFolder(req);
    const client = await getConnectedClient(req.accountId);
    const r = await listMessages(client, peer, {
      limit: Math.min(Number(req.query.limit) || 60, 200),
      offsetId: req.query.offsetId || 0,
      search: req.query.search || undefined,
    });
    res.json(r);
  } catch (e) {
    next(e);
  }
});

api.post("/v1/files", requireApiKey, async (req, res, next) => {
  const dbJobId = uid();
  let tmp = "";
  let upDir = "";
  try {
    const { row, peer } = await loadFolder(req);
    const client = await getConnectedClient(req.accountId);
    const fileName = safeFilename(req.headers["x-filename"] ? decodeURIComponent(req.headers["x-filename"]) : "file");
    const sizeCheck = checkDeclaredUploadSize(req.headers["x-filesize"], config.maxUploadBytes);
    if (!sizeCheck.ok) {
      throw new HttpError(413, `File exceeds the maximum allowed size of ${fmtBytes(config.maxUploadBytes)}`);
    }
    const size = sizeCheck.size;
    const caption = req.headers["x-caption"] ? decodeURIComponent(req.headers["x-caption"]) : "";
    const forceDocument = req.headers["x-force-document"] !== "0";

    await stmt.addUploadJob({
      id: dbJobId,
      account_id: req.accountId,
      user_id: null,
      api_key_id: req.apiKeyId || null,
      folder_id: row.id,
      peer_json: row.peer_json,
      file_name: fileName,
      mime: null,
      caption,
      force_document: forceDocument,
      total_bytes: size || null,
      created_at: Date.now(),
    });

    const listed = await listMessages(client, peer, { limit: 200 });
    const existing = listed.items || [];
    if (hasDuplicateNameSize({ name: fileName, size }, existing)) {
      throw new HttpError(409, `A file named “${fileName}” with the same size already exists in this folder.`);
    }

    fs.mkdirSync(config.uploadTmpDir, { recursive: true });
    upDir = fs.mkdtempSync(path.join(config.uploadTmpDir, "tgd-api-"));
    tmp = `${upDir}/${fileName}`;
    await stmt.markUploadJobStarted(dbJobId, tmp, Date.now());
    let received = 0;
    let sizeExceeded = false;
    let cancelled = false;
    let lastPersist = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        const onData = (c) => {
          if (isUploadJobCancelRequested(dbJobId)) {
            cancelled = true;
            req.removeListener("data", onData);
            out.destroy(new Error("UPLOAD_CANCELLED"));
            req.destroy(new Error("UPLOAD_CANCELLED"));
            return;
          }
          if (wouldExceedUploadLimit(received, c.length, config.maxUploadBytes)) {
            sizeExceeded = true;
            req.removeListener("data", onData);
            out.destroy(new Error("UPLOAD_SIZE_EXCEEDED"));
            req.destroy(new Error("UPLOAD_SIZE_EXCEEDED"));
            return;
          }
          received += c.length;
          const now = Date.now();
          if (shouldPersistUploadProgress(lastPersist, now)) {
            lastPersist = now;
            stmt.updateUploadJobProgress(dbJobId, { receivedBytes: received, uploadedBytes: 0 }, now).catch(() => {});
          }
        };
        req.on("data", onData);
        req.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
        req.on("error", reject);
      });
    } catch (streamErr) {
      if (cancelled || streamErr?.message === "UPLOAD_CANCELLED") throw new Error("UPLOAD_CANCELLED");
      if (sizeExceeded || streamErr?.message === "UPLOAD_SIZE_EXCEEDED") {
        throw new HttpError(413, `File exceeds the maximum allowed size of ${fmtBytes(config.maxUploadBytes)}`);
      }
      throw streamErr;
    }
    const sent = await uploadFile(client, peer, {
      filePath: tmp,
      fileName,
      fileSize: size || undefined,
      caption,
      forceDocument,
      shouldAbort: () => isUploadJobCancelRequested(dbJobId),
      onProgress: (uploaded) => {
        stmt.updateUploadJobProgress(dbJobId, { receivedBytes: size, uploadedBytes: Number(uploaded) || 0 }, Date.now()).catch(() => {});
      },
    });
    await cleanupPath(upDir, { label: "upload-dir-cleanup" });
    const file = serializeMessage(sent);
    await stmt.markUploadJobCompleted(dbJobId, { msgId: file?.id }, Date.now());
    res.json({ ok: true, file });
  } catch (e) {
    if (upDir) await cleanupPath(upDir, { label: "upload-dir-cleanup" });
    const cancelled = e?.message === "UPLOAD_CANCELLED" || e?.name === "UploadCancelledError";
    if (!cancelled) {
      try {
        const current = await stmt.getUploadJob(dbJobId);
        if (current && current.status !== "cancelled") {
          await stmt.markUploadJobFailed(dbJobId, String(e?.message || e), Date.now());
        }
      } catch {}
    }
    clearUploadJobCancel(dbJobId);
    if (cancelled) return res.status(499).end();
    next(e);
  }
});

api.get("/v1/files/:id/raw", requireApiKey, async (req, res, next) => {
  try {
    const { peer } = await loadFolder(req);
    const client = await getConnectedClient(req.accountId);
    const msg = await getOne(client, peer, req.params.id);
    await streamToResponse(client, msg, req, res, { attachment: req.query.dl === "1" });
  } catch (e) {
    if (!res.headersSent) next(e);
  }
});

api.delete("/v1/files", requireApiKey, async (req, res, next) => {
  try {
    const { peer } = await loadFolder(req);
    const client = await getConnectedClient(req.accountId);
    let ids = req.query.ids;
    if (typeof ids === "string") ids = ids.split(",").map((x) => x.trim());
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });
    await deleteFiles(client, peer, ids);
    res.json({ ok: true, deleted: ids.length });
  } catch (e) {
    next(e);
  }
});

/* ---- key management (admin only) ---- */
keys.get("/keys", requireAppAuth, requireAdmin, async (req, res) => {
  res.json({ keys: await stmt.listApiKeys() });
});

keys.post("/keys", requireAppAuth, requireAdmin, async (req, res) => {
  const { label, account } = req.body || {};
  if (!account) return res.status(400).json({ error: "account required (account to bind this key to)" });
  if (!(await stmt.getAccount(account))) return res.status(404).json({ error: "Account not found" });
  const id = uid();
  const plain = "tdk_" + token(20);
  await stmt.addApiKey({
    id,
    token_hash: hashKey(plain),
    label: String(label || "API key"),
    account_id: account,
    created_at: Date.now(),
  });
  res.json({ ok: true, id, key: plain, label: label || "API key", accountId: account });
});

keys.delete("/keys/:id", requireAppAuth, requireAdmin, async (req, res) => {
  await stmt.deleteApiKey(req.params.id);
  res.json({ ok: true });
});

import { Router } from "express";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { stmt } from "../db.js";
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
import { tempPath, safeFilename, uid, token } from "../util.js";

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
  let tmp = "";
  let upDir = "";
  try {
    const { peer } = await loadFolder(req);
    const client = await getConnectedClient(req.accountId);
    const fileName = safeFilename(req.headers["x-filename"] ? decodeURIComponent(req.headers["x-filename"]) : "file");
    const size = Number(req.headers["x-filesize"] || 0);
    const caption = req.headers["x-caption"] ? decodeURIComponent(req.headers["x-caption"]) : "";
    const forceDocument = req.headers["x-force-document"] !== "0";
    upDir = fs.mkdtempSync("/tmp/tgd-api-");
    tmp = `${upDir}/${fileName}`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      req.on("error", reject);
    });
    const sent = await uploadFile(client, peer, {
      filePath: tmp,
      fileName,
      fileSize: size || undefined,
      caption,
      forceDocument,
    });
    fs.rm(upDir, { recursive: true, force: true }, () => {});
    res.json({ ok: true, file: serializeMessage(sent) });
  } catch (e) {
    if (upDir) fs.rm(upDir, { recursive: true, force: true }, () => {});
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

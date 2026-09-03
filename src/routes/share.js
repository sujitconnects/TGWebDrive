import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import archiver from "archiver";
import { stmt, withTransaction } from "../db.js";
import { requireAppAuth, requireAccount, canAccessFolder } from "../middleware.js";
import { getConnectedClient, HttpError } from "../tg/manager.js";
import { buildPeer, getOne, serializeMessage, serializeMultipart, parseParts, streamToResponse, streamMultipart, streamThumb, listMessages } from "../tg/operations.js";
import { config } from "../config.js";
import { hashPassword, verifyPassword, shortId, safeFilename } from "../util.js";

export const share = Router(); // mounted under /api  (metadata + management)
export const pubBin = Router(); // mounted at root (binary streams + zip)

const b64 = (b) => Buffer.from(b).toString("base64url");
function signAccess(shareId, ttlSec = 3600 * 6) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${shareId}.${exp}`;
  const sig = b64(createHmac("sha256", config.secret).update(payload).digest());
  return `${payload}.${sig}`;
}
function verifyAccess(tok, shareId) {
  if (!tok) return false;
  const parts = tok.split(".");
  if (parts.length !== 3) return false;
  const [sid, exp, sig] = parts;
  if (sid !== shareId) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const expect = b64(createHmac("sha256", config.secret).update(`${sid}.${exp}`).digest());
  try {
    return sig.length === expect.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch {
    return false;
  }
}

function publicShare(s) {
  return {
    id: s.id,
    kind: s.kind || "file",
    name: s.name,
    mime: s.mime,
    size: s.size,
    needsPassword: !!s.password_hash,
    expiresAt: s.expires_at,
    expired: s.expires_at && s.expires_at < Date.now(),
    createdAt: s.created_at,
    downloads: s.downloads,
    msgIds: s.msg_ids ? JSON.parse(s.msg_ids) : null,
  };
}

async function loadShareOrDeny(req, res) {
  const s = await stmt.getShare(req.params.id);
  if (!s) {
    res.status(404).json({ error: "Share not found" });
    return null;
  }
  if (s.expires_at && s.expires_at < Date.now()) {
    res.status(410).json({ error: "Share expired" });
    return null;
  }
  const token = req.query.token || req.headers["x-share-token"];
  if (s.password_hash && !verifyAccess(token, s.id)) {
    res.status(401).json({ error: "Password required", needsPassword: true });
    return null;
  }
  return s;
}

/* ============ metadata + management (under /api) ============ */

share.get("/public/share/:id", async (req, res) => {
  const s = await stmt.getShare(req.params.id);
  if (!s) return res.status(404).json({ error: "Share not found" });
  if (s.expires_at && s.expires_at < Date.now()) return res.status(410).json({ error: "Share expired" });
  res.json(publicShare(s));
});

share.post("/public/share/:id/access", async (req, res) => {
  const s = await stmt.getShare(req.params.id);
  if (!s) return res.status(404).json({ error: "Share not found" });
  if (s.expires_at && s.expires_at < Date.now()) return res.status(410).json({ error: "Share expired" });
  if (!s.password_hash) return res.json({ token: signAccess(s.id) });
  if (!verifyPassword(String(req.body?.password || ""), s.password_hash))
    return res.status(401).json({ error: "Wrong password" });
  res.json({ token: signAccess(s.id) });
});

share.get("/public/share/:id/files", async (req, res, next) => {
  try {
    const s = await loadShareOrDeny(req, res);
    if (!s) return;
    if ((s.kind || "file") !== "folder" && !s.msg_ids) return res.status(400).json({ error: "Not a multi-file share" });
    const client = await getConnectedClient(s.account_id);
    const peer = buildPeer({ peer_json: s.peer_json });
    const r = await listMessages(client, peer, { limit: 200 });
    const token = encodeURIComponent(req.query.token || "");
    // Filter items based on share type
    let items = r.items;
    if (s.msg_ids) {
      // Multi-file share: filter by msg_ids array
      const allowedIds = JSON.parse(s.msg_ids).map(Number);
      items = items.filter(f => allowedIds.includes(Number(f.id)));
    } else if (s.msg_id) {
      // Single file share: filter by msg_id
      items = items.filter(f => Number(f.id) === Number(s.msg_id));
    }
    const mapped = items.map((f) => ({
      ...f,
      rawUrl: `/s/${s.id}/file/${f.id}/raw${token ? "?token=" + token : ""}`,
      thumbUrl: `/s/${s.id}/file/${f.id}/thumb${token ? "?token=" + token : ""}`,
    }));
    res.json({ items: mapped });
  } catch (e) {
    next(e);
  }
});

share.get("/shares", requireAppAuth, requireAccount, async (req, res) => {
  const list = (await stmt.listShares())
    .filter((s) => s.account_id === req.accountId)
    .map((s) => ({ ...publicShare(s), url: `${config.publicUrl}/s/${s.id}` }));
  res.json({ shares: list });
});

share.get("/shares/for", requireAppAuth, requireAccount, async (req, res) => {
  const row = await stmt.getFolder(req.query.folder, req.accountId);
  if (!row || !canAccessFolder(req, row.id)) return res.status(404).json({ error: "Folder not found" });
  let s;
  if (req.query.multipartId) {
    s = await stmt.getShareByMultipart(req.accountId, row.peer_json, String(req.query.multipartId));
  } else {
    s = await stmt.getShareByFile(req.accountId, row.peer_json, Number(req.query.msgId));
  }
  if (!s) return res.json({ none: true });
  res.json({ share: { ...publicShare(s), url: `${config.publicUrl}/s/${s.id}` } });
});

share.get("/shares/forFolder", requireAppAuth, requireAccount, async (req, res) => {
  const row = await stmt.getFolder(req.query.folder, req.accountId);
  if (!row || !canAccessFolder(req, row.id)) return res.status(404).json({ error: "Folder not found" });
  const s = await stmt.getFolderShare(req.accountId, row.peer_json);
  if (!s) return res.json({ none: true });
  res.json({ share: { ...publicShare(s), url: `${config.publicUrl}/s/${s.id}` } });
});

share.post("/shares", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const { folder, msgId, msgIds, multipartId, name, mime, size, password, expiresInHours, kind, title } = req.body || {};
    const row = await stmt.getFolder(folder, req.accountId);
      if (!row || !canAccessFolder(req, row.id)) return res.status(404).json({ error: "Folder not found" });
    const shareKind = kind === "folder" ? "folder" : "file";
    const expiresAt = expiresInHours ? Date.now() + Number(expiresInHours) * 3600 * 1000 : null;
    const id = shortId(10);

    // Support both single file (msgId) and multi-file (msgIds array) shares
    const finalMsgIds = msgIds ? msgIds.map(Number) : null;

    // deleting the previous share and inserting the new one must be atomic —
    // otherwise a failed insert (e.g. a constraint error) leaves the folder/file
    // with no working share link at all.
    await withTransaction(async (q) => {
      if (shareKind === "folder") {
        await q(`DELETE FROM shares WHERE account_id = $1 AND peer_json = $2 AND kind = 'folder'`, [req.accountId, row.peer_json]);
        await q(
          `INSERT INTO shares (id,account_id,peer_json,msg_id,msg_ids,multipart_id,name,mime,size,password_hash,expires_at,created_at,kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, req.accountId, row.peer_json, null, null, null, title || row.title || "Folder", null, null, password ? hashPassword(password) : null, expiresAt, Date.now(), "folder"]
        );
      } else if (multipartId) {
        // a split (multipart) file shared as one logical file
        const mp = await stmt.getMultipart(String(multipartId));
        if (!mp || mp.account_id !== req.accountId) throw new HttpError(404, "File not found");
        await q(`DELETE FROM shares WHERE multipart_id = $1`, [String(multipartId)]);
        await q(
          `INSERT INTO shares (id,account_id,peer_json,msg_id,msg_ids,multipart_id,name,mime,size,password_hash,expires_at,created_at,kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id, req.accountId, row.peer_json, null, null, String(multipartId),
            name || mp.name || null, mime || mp.mime || null, size || mp.size || null,
            password ? hashPassword(password) : null, expiresAt, Date.now(), "file",
          ]
        );
      } else if (finalMsgIds && finalMsgIds.length > 0) {
        // Multi-file share or single file share
        const msgIdsJson = finalMsgIds.length > 1 ? JSON.stringify(finalMsgIds) : null;
        const singleMsgId = finalMsgIds.length === 1 ? finalMsgIds[0] : null;
        
        // Delete old shares for this file (if single file)
        if (singleMsgId) {
          await q(`DELETE FROM shares WHERE account_id = $1 AND peer_json = $2 AND msg_id = $3`, [req.accountId, row.peer_json, singleMsgId]);
        }
        
        await q(
          `INSERT INTO shares (id,account_id,peer_json,msg_id,msg_ids,multipart_id,name,mime,size,password_hash,expires_at,created_at,kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, req.accountId, row.peer_json, singleMsgId, msgIdsJson, null, name || null, mime || null, size || null, password ? hashPassword(password) : null, expiresAt, Date.now(), "file"]
        );
      } else if (msgId) {
        // Backward compatibility: single msgId parameter
        await q(`DELETE FROM shares WHERE account_id = $1 AND peer_json = $2 AND msg_id = $3`, [req.accountId, row.peer_json, Number(msgId)]);
        await q(
          `INSERT INTO shares (id,account_id,peer_json,msg_id,msg_ids,multipart_id,name,mime,size,password_hash,expires_at,created_at,kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, req.accountId, row.peer_json, Number(msgId), null, null, name || null, mime || null, size || null, password ? hashPassword(password) : null, expiresAt, Date.now(), "file"]
        );
      } else {
        throw new HttpError(400, "msgId or msgIds required");
      }
    });
    res.json({ ok: true, id, kind: shareKind, url: `${config.publicUrl}/s/${id}`, expiresAt });
  } catch (e) {
    next(e);
  }
});

share.delete("/shares/:id", requireAppAuth, requireAccount, async (req, res) => {
  const s = await stmt.getShare(req.params.id);
  if (s && s.account_id === req.accountId) await stmt.deleteShare(req.params.id);
  res.json({ ok: true });
});

/* ============ binary streams + zip (mounted at root) ============ */

// file share: raw + thumb
pubBin.get("/s/:id/raw", async (req, res, next) => {
  try {
    const s = await loadShareOrDeny(req, res);
    if (!s) return;
    const client = await getConnectedClient(s.account_id);
    const peer = buildPeer({ peer_json: s.peer_json });
    await stmt.incShareDownload(s.id);
    if (s.multipart_id) {
      const mp = await stmt.getMultipart(s.multipart_id);
      if (!mp) return res.status(404).end();
      return await streamMultipart(client, peer, parseParts(mp), Number(mp.size), req, res, {
        attachment: req.query.dl === "1",
        name: s.name || mp.name,
        mime: s.mime || mp.mime,
      });
    }
    const msg = await getOne(client, peer, s.msg_id);
    await streamToResponse(client, msg, req, res, { attachment: req.query.dl === "1", name: s.name, mime: s.mime });
  } catch (e) {
    if (!res.headersSent) next(e);
  }
});

pubBin.get("/s/:id/thumb", async (req, res, next) => {
  try {
    const s = await loadShareOrDeny(req, res);
    if (!s) return;
    if (s.multipart_id) return res.status(404).end();
    const client = await getConnectedClient(s.account_id);
    const peer = buildPeer({ peer_json: s.peer_json });
    const msg = await getOne(client, peer, s.msg_id);
    await streamThumb(client, msg, res, `share-${s.id}-${s.msg_id}`);
  } catch (e) {
    if (!res.headersSent) res.status(404).end();
  }
});

// folder share: per-file raw + thumb
pubBin.get("/s/:id/file/:msgId/raw", async (req, res, next) => {
  try {
    const s = await loadShareOrDeny(req, res);
    if (!s) return;
    if ((s.kind || "file") !== "folder" && !s.msg_ids) return res.status(400).end();
    const client = await getConnectedClient(s.account_id);
    const peer = buildPeer({ peer_json: s.peer_json });
    const msg = await getOne(client, peer, req.params.msgId);
    await streamToResponse(client, msg, req, res, { attachment: req.query.dl === "1" });
  } catch (e) {
    if (!res.headersSent) next(e);
  }
});

pubBin.get("/s/:id/file/:msgId/thumb", async (req, res, next) => {
  try {
    const s = await loadShareOrDeny(req, res);
    if (!s) return;
    const client = await getConnectedClient(s.account_id);
    const peer = buildPeer({ peer_json: s.peer_json });
    const msg = await getOne(client, peer, req.params.msgId);
    await streamThumb(client, msg, res, `share-${s.id}-${req.params.msgId}`);
  } catch (e) {
    if (!res.headersSent) res.status(404).end();
  }
});

// folder share: download all as ZIP
pubBin.get("/s/:id/zip", async (req, res, next) => {
  try {
    const s = await loadShareOrDeny(req, res);
    if (!s) return;
    if ((s.kind || "file") !== "folder" && !s.msg_ids) return res.status(400).end();
    const client = await getConnectedClient(s.account_id);
    const peer = buildPeer({ peer_json: s.peer_json });
    const r = await listMessages(client, peer, { limit: 200 });
    const allowedIds = s.msg_ids ? new Set(JSON.parse(s.msg_ids).map(Number)) : null;
    const items = allowedIds ? r.items.filter((file) => allowedIds.has(Number(file.id))) : r.items;
    const zipName = safeFilename((s.name || "folder") + ".zip");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.setHeader("Cache-Control", "no-store");
    const archive = archiver("zip", { zlib: { level: 5 } });
    archive.on("error", (e) => {
      if (!res.headersSent) next(e);
      else res.end();
    });
    archive.pipe(res);
    const used = new Set();
    for (const f of items) {
      try {
        const msg = await getOne(client, peer, f.id);
        const buf = await client.downloadMedia(msg);
        if (!Buffer.isBuffer(buf) || !buf.length) continue;
        let name = safeFilename(f.name || `file_${f.id}`);
        if (used.has(name)) name = `${Date.now()}-${name}`;
        used.add(name);
        archive.append(buf, { name, date: new Date((f.date || 0) * 1000) });
      } catch {}
    }
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) next(e);
  }
});

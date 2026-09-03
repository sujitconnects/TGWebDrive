import { Router } from "express";
import { stmt } from "../db.js";
import { requireAppAuth, requireAccount } from "../middleware.js";
import { getConnectedClient } from "../tg/manager.js";
import { buildPeer, createChannelFolder, renameChannelFolder, deleteChannelFolder, listDialogs, SAVED_PEER } from "../tg/operations.js";
import { uid } from "../util.js";

export const folders = Router();

async function ensureSaved(accountId) {
  const existing = (await stmt.foldersFor(accountId)).find((f) => f.kind === "saved");
  if (existing) return existing.id;
  const id = uid();
  await stmt.addFolder({
    id,
    account_id: accountId,
    parent_id: null,
    title: "Saved Messages",
    peer_json: JSON.stringify(SAVED_PEER),
    kind: "saved",
    created_at: Date.now(),
  });
  return id;
}

folders.get("/folders", requireAppAuth, requireAccount, async (req, res) => {
  await ensureSaved(req.accountId);
  const list = (await stmt.foldersFor(req.accountId)).map((f) => ({
    id: f.id,
    title: f.title,
    kind: f.kind,
    isSaved: f.kind === "saved",
    parentId: f.parent_id || null,
  }));
  res.json({ folders: list });
});

folders.post("/folders", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "Folder name required" });
    const parentId = req.body?.parentId ? String(req.body.parentId) : null;
    if (parentId) {
      const parent = await stmt.getFolder(parentId, req.accountId);
      if (!parent) return res.status(404).json({ error: "Parent folder not found" });
    }
    const client = await getConnectedClient(req.accountId);
    const created = await createChannelFolder(client, title);
    const id = uid();
    await stmt.addFolder({
      id,
      account_id: req.accountId,
      parent_id: parentId,
      title,
      peer_json: JSON.stringify(created.peer_json),
      kind: "channel",
      created_at: Date.now(),
    });
    res.json({ ok: true, id, title, parentId });
  } catch (e) {
    next(e);
  }
});

folders.get("/chats", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const client = await getConnectedClient(req.accountId);
    const chats = await listDialogs(client);
    res.json({ chats });
  } catch (e) {
    next(e);
  }
});

folders.post("/folders/import", requireAppAuth, requireAccount, async (req, res) => {
  const { channelId, accessHash, title } = req.body || {};
  if (!channelId || accessHash == null || !title) return res.status(400).json({ error: "channelId, accessHash, title required" });
  const id = uid();
  await stmt.addFolder({
    id,
    account_id: req.accountId,
    parent_id: null,
    title,
    peer_json: JSON.stringify({ kind: "channel", channelId: String(channelId), accessHash: String(accessHash) }),
    kind: "channel",
    created_at: Date.now(),
  });
  res.json({ ok: true, id, title });
});

folders.patch("/folders/:id", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "Folder name required" });
    const row = await stmt.getFolder(req.params.id, req.accountId);
    if (!row) return res.status(404).json({ error: "Folder not found" });
    if (row.kind === "saved") return res.status(400).json({ error: "Saved Messages can't be renamed" });
    const client = await getConnectedClient(req.accountId);
    await renameChannelFolder(client, buildPeer(row), title);
    await stmt.renameFolder(req.params.id, req.accountId, title);
    res.json({ ok: true, title });
  } catch (e) {
    next(e);
  }
});

folders.delete("/folders/:id", requireAppAuth, requireAccount, async (req, res, next) => {
  try {
    const target = await stmt.getFolder(req.params.id, req.accountId);
    if (target && target.kind === "saved") return res.status(400).json({ error: "Saved Messages can't be deleted" });
    // Recursively remove descendant subfolders so nothing is orphaned.
    const all = await stmt.foldersFor(req.accountId);
    const childrenOf = (pid) => all.filter((f) => f.parent_id === pid).map((f) => f.id);
    const stack = [req.params.id];
    const visited = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const cid of childrenOf(cur)) stack.push(cid);
    }
    const rows = all.filter((f) => visited.has(f.id));
    if (rows.length) {
      const client = await getConnectedClient(req.accountId);
      for (const row of rows) {
        try {
          await deleteChannelFolder(client, buildPeer(row));
        } catch (e) {
          // channel may already be gone/left — don't block removing the local record
        }
      }
    }
    for (const id of visited) await stmt.deleteFolder(id, req.accountId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

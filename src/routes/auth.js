import { Router } from "express";
import { stmt } from "../db.js";
import {
  isSetup,
  requireAppAuth,
  requireAdmin,
  requireAccount,
  createSession,
  getSession,
  updateSession,
  destroySession,
  destroyUserSessions,
} from "../middleware.js";
import { hashPassword, verifyPassword, uid } from "../util.js";
import { beginLogin, resendCode, finishLogin, cancelLogin, dropClient } from "../tg/manager.js";

export const auth = Router();

function publicAccount(a) {
  return {
    id: a.id,
    label: a.label,
    phone: a.phone,
    username: a.username,
    premium: !!a.is_premium,
    createdAt: a.created_at,
    lastUsedAt: a.last_used_at,
  };
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.created_at };
}

auth.get("/auth/state", async (req, res) => {
  const s = await getSession(req);
  const loggedIn = !!s;
  const accounts = loggedIn ? (await stmt.listAccounts()).map(publicAccount) : [];
  res.json({
    needsSetup: !(await isSetup()),
    loggedIn,
    user: loggedIn ? { id: s.userId, username: s.username, role: s.role, isAdmin: s.role === "admin" } : null,
    currentAccountId: s?.currentAccountId || null,
    accounts,
    hasAccount: accounts.length > 0,
  });
});

auth.post("/auth/setup", async (req, res) => {
  if (await isSetup()) return res.status(409).json({ error: "Already set up" });
  const username = String(req.body?.username || "admin").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[a-z0-9_.-]{3,32}$/i.test(username)) return res.status(400).json({ error: "Username must be 3-32 chars (letters, numbers, _ . -)" });
  if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
  const id = uid();
  try {
    await stmt.addUser({ id, username, password_hash: hashPassword(password), role: "admin", created_at: Date.now() });
  } catch (e) {
    return res.status(400).json({ error: "Username already exists" });
  }
  await createSession(req, res, { id, username, role: "admin" }, { remember: true });
  res.json({ ok: true });
});

auth.post("/auth/login", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const remember = req.body?.remember !== false && req.body?.remember !== "false";
  const user = await stmt.getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Wrong username or password" });
  await createSession(req, res, { id: user.id, username: user.username, role: user.role }, { remember });
  res.json({ ok: true });
});

auth.post("/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

auth.post("/auth/password", requireAppAuth, async (req, res) => {
  const cur = String(req.body?.current || "");
  const next = String(req.body?.next || "");
  const user = await stmt.getUserById(req.user.id);
  if (!user || !verifyPassword(cur, user.password_hash)) return res.status(401).json({ error: "Current password is wrong" });
  if (next.length < 4) return res.status(400).json({ error: "New password must be at least 4 characters" });
  await stmt.updateUser({ id: user.id, password_hash: hashPassword(next), role: user.role });
  res.json({ ok: true });
});

/* -------- Users (admin only) -------- */

auth.get("/users", requireAppAuth, requireAdmin, requireAccount, async (req, res) => {
  const users = await stmt.listUsers();
  res.json({ users: await Promise.all(users.map(async (user) => ({ ...publicUser(user), folderIds: (await stmt.userFolderIds(user.id)).map((row) => row.folder_id) }))), currentUserId: req.user.id });
});

auth.post("/users", requireAppAuth, requireAdmin, requireAccount, async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const role = req.body?.role === "admin" ? "admin" : "user";
  const folderIds = Array.isArray(req.body?.folderIds) ? [...new Set(req.body.folderIds.map(String))] : [];
  if (!/^[a-z0-9_.-]{3,32}$/i.test(username)) return res.status(400).json({ error: "Username must be 3-32 chars (letters, numbers, _ . -)" });
  if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
  const id = uid();
  const folders = await stmt.foldersFor(req.accountId);
  if (folderIds.some((folderId) => !folders.some((folder) => folder.id === folderId))) return res.status(400).json({ error: "Invalid folder access" });
  try {
    await stmt.addUser({ id, username, password_hash: hashPassword(password), role, created_at: Date.now() });
    if (role !== "admin") await stmt.setUserFolders(id, folderIds);
  } catch (e) {
    return res.status(400).json({ error: "Username already exists" });
  }
  res.json({ ok: true, user: publicUser(await stmt.getUserById(id)) });
});

auth.patch("/users/:id", requireAppAuth, requireAdmin, async (req, res) => {
  const user = await stmt.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const role = req.body?.role === "admin" ? "admin" : req.body?.role === "user" ? "user" : user.role;
  // never remove the last admin
  if (user.role === "admin" && role === "user") {
    const admins = (await stmt.listUsers()).filter((u) => u.role === "admin").length;
    if (admins <= 1) return res.status(400).json({ error: "Cannot demote the last admin" });
  }
  const next = String(req.body?.password || "");
  const password_hash = next.length >= 4 ? hashPassword(next) : user.password_hash;
  await stmt.updateUser({ id: user.id, password_hash, role });
  res.json({ ok: true });
});

auth.delete("/users/:id", requireAppAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  const user = await stmt.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role === "admin") {
    const admins = (await stmt.listUsers()).filter((u) => u.role === "admin").length;
    if (admins <= 1) return res.status(400).json({ error: "Cannot delete the last admin" });
  }
  await stmt.deleteUser(req.params.id);
  await destroyUserSessions(req.params.id);
  res.json({ ok: true });
});

/* -------- Telegram login (admin only) -------- */

auth.post("/auth/tg/request", requireAppAuth, requireAdmin, async (req, res, next) => {
  try {
    const { apiId, apiHash, phone } = req.body || {};
    if (!apiId || !apiHash || !phone) return res.status(400).json({ error: "apiId, apiHash and phone are required" });
    res.json(await beginLogin(Number(apiId), String(apiHash), String(phone)));
  } catch (e) {
    next(e);
  }
});

auth.post("/auth/tg/resend", requireAppAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await resendCode(req.body?.tempToken)) });
  } catch (e) {
    next(e);
  }
});

auth.post("/auth/tg/code", requireAppAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await finishLogin(req.body?.tempToken, req.body?.code, null);
    if (r.id) await updateSession(req, { currentAccountId: r.id });
    res.json({ ok: true, account: r });
  } catch (e) {
    if (e?.code === "2FA_NEEDED") return res.status(449).json({ needPassword: true });
    next(e);
  }
});

auth.post("/auth/tg/password", requireAppAuth, requireAdmin, async (req, res, next) => {
  try {
    const r = await finishLogin(req.body?.tempToken, null, req.body?.password);
    if (r.id) await updateSession(req, { currentAccountId: r.id });
    res.json({ ok: true, account: r });
  } catch (e) {
    next(e);
  }
});

auth.post("/auth/tg/cancel", requireAppAuth, requireAdmin, (req, res) => {
  cancelLogin(req.body?.tempToken);
  res.json({ ok: true });
});

/* -------- Accounts -------- */

auth.get("/accounts", requireAppAuth, async (req, res) => {
  res.json({ accounts: (await stmt.listAccounts()).map(publicAccount) });
});

auth.post("/accounts/switch/:id", requireAppAuth, async (req, res) => {
  const acc = await stmt.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "Account not found" });
  await updateSession(req, { currentAccountId: req.params.id });
  res.json({ ok: true });
});

auth.delete("/accounts/:id", requireAppAuth, requireAdmin, async (req, res, next) => {
  try {
    dropClient(req.params.id);
    await stmt.deleteAccount(req.params.id);
    if (req.session?.currentAccountId === req.params.id) await updateSession(req, { currentAccountId: null });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

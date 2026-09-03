import { metaGet, metaSet, stmt } from "./db.js";
import { verifyPassword, token } from "./util.js";

// Sessions are persisted in SQLite so server restarts no longer log people out.
// A "remember me" login opts into the longer-lived cookie/session.
const TTL_REMEMBER = 1000 * 60 * 60 * 24 * 90; // 90 days
const TTL_SESSION = 1000 * 60 * 60 * 24 * 1; // 1 day

// Purge expired sessions occasionally.
async function gc() {
  try {
    await stmt.deleteExpiredSessions(Date.now());
  } catch {}
}
setInterval(gc, 60 * 60 * 1000).unref();

// cookies are marked secure when served over HTTPS via the proxy
function cookieSecure(req) {
  return !!(req.secure || req.protocol === "https" || req.headers["x-forwarded-proto"] === "https");
}

export async function createSession(req, res, user, { remember = false, currentAccountId = null } = {}) {
  const sid = token(24);
  const now = Date.now();
  const ttl = remember ? TTL_REMEMBER : TTL_SESSION;
  await stmt.addSession({
    sid,
    user_id: user.id,
    username: user.username,
    role: user.role,
    current_account_id: currentAccountId,
    created_at: now,
    expires_at: now + ttl,
  });
  setCookie(req, res, sid, ttl);
  return sid;
}

export function setCookie(req, res, sid, ttlMs = TTL_SESSION) {
  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    maxAge: ttlMs,
    path: "/",
  });
}

export async function getSession(req) {
  const sid = req.cookies?.sid;
  if (!sid) return null;
  const row = await stmt.getSession(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await stmt.deleteSession(sid);
    return null;
  }
  return {
    sid,
    userId: row.user_id,
    username: row.username,
    role: row.role,
    currentAccountId: row.current_account_id || null,
    createdAt: row.created_at,
  };
}

export async function updateSession(req, patch) {
  const sid = req.cookies?.sid;
  if (!sid) return;
  if (patch && Object.prototype.hasOwnProperty.call(patch, "currentAccountId")) {
    await stmt.updateSessionRow({ sid, current_account_id: patch.currentAccountId ?? null });
  }
}

export async function destroySession(req, res) {
  const sid = req.cookies?.sid;
  if (sid) await stmt.deleteSession(sid);
  res.clearCookie("sid", { path: "/" });
}

export async function destroyUserSessions(userId) {
  await stmt.deleteSessionsByUser(userId);
}

export async function isSetup() {
  return (await stmt.countUsers()).c > 0;
}

export async function requireAppAuth(req, res, next) {
  const s = await getSession(req);
  if (!s) return res.status(401).json({ error: "Not authenticated", needsLogin: true });
  req.session = s;
  req.user = { id: s.userId, username: s.username, role: s.role };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

export async function requireAccount(req, res, next) {
  try {
    const accId = req.session.currentAccountId || req.headers["x-account"] || req.query.account;
    if (!accId) return res.status(409).json({ error: "No Telegram account selected", noAccount: true });
    req.accountId = accId;
    if (req.user.role !== "admin") {
      const rows = await stmt.folderIdsForUser(accId, req.user.id);
      req.allowedFolderIds = new Set(rows.map((row) => row.id));
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function canAccessFolder(req, folderId) {
  return req.user?.role === "admin" || !req.allowedFolderIds || req.allowedFolderIds.has(String(folderId));
}

export { metaGet, metaSet, verifyPassword };

import pg from "pg";
import { config } from "./config.js";
import { uid } from "./util.js";

// created_at/last_used_at/expires_at/size are BIGINT in Postgres; pg returns
// int8 as a string by default, but every value we store fits well inside
// Number.MAX_SAFE_INTEGER, so parse them back to numbers app-wide.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function one(sql, params = []) {
  return (await query(sql, params))[0] || null;
}

// Run multiple statements atomically so a failed step never leaves e.g. an
// old share deleted but the replacement never inserted.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((sql, params) => client.query(sql, params).then((r) => r.rows));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      phone TEXT,
      user_id TEXT,
      username TEXT,
      api_id INTEGER NOT NULL,
      api_hash TEXT NOT NULL,
      session TEXT NOT NULL,
      is_premium INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      parent_id TEXT,
      title TEXT NOT NULL,
      peer_json TEXT NOT NULL,
      kind TEXT NOT NULL, -- 'saved' | 'channel'
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      peer_json TEXT NOT NULL,
      msg_id INTEGER,
      msg_ids TEXT, -- JSON array of msg IDs for multi-file shares
      multipart_id TEXT,
      name TEXT,
      mime TEXT,
      size BIGINT,
      password_hash TEXT,
      expires_at BIGINT,
      downloads INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'file'
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_folders (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, folder_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      current_account_id TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS multipart_files (
      id TEXT PRIMARY KEY, -- logical file id, prefixed 'mp_'
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      peer_json TEXT NOT NULL, -- folder peer this file lives in
      name TEXT NOT NULL,
      mime TEXT,
      size BIGINT NOT NULL, -- total reassembled size
      parts_json TEXT NOT NULL, -- JSON [{ msgId, size }, ...] in order
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multipart_peer ON multipart_files(account_id, peer_json);
  `);

  // Migration: folder/multipart shares have no single message, so msg_id must be nullable.
  await pool.query(`ALTER TABLE shares ALTER COLUMN msg_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE shares ADD COLUMN IF NOT EXISTS msg_ids TEXT`);

  // Migration: seed an admin user from the legacy single admin password (if present),
  // so existing installs keep working after the upgrade to multi-user.
  const { c } = await one(`SELECT COUNT(*)::int AS c FROM users`);
  if (c === 0) {
    const legacy = await metaGet("admin_password");
    if (legacy) {
      await stmt.addUser({ id: uid(), username: "admin", password_hash: legacy, role: "admin", created_at: Date.now() });
    }
  }
}

export async function metaGet(k, dflt = null) {
  const row = await one(`SELECT v FROM meta WHERE k = $1`, [k]);
  return row ? row.v : dflt;
}
export async function metaSet(k, v) {
  await query(`INSERT INTO meta(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, String(v)]);
}

export const stmt = {
  addAccount: (a) =>
    query(
      `INSERT INTO accounts (id,label,phone,user_id,username,api_id,api_hash,session,is_premium,created_at,last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [a.id, a.label, a.phone, a.user_id, a.username, a.api_id, a.api_hash, a.session, a.is_premium, a.created_at, a.last_used_at]
    ),
  listAccounts: () => query(`SELECT * FROM accounts ORDER BY last_used_at DESC`),
  accountsForUser: (userId) => query(`SELECT DISTINCT a.* FROM accounts a JOIN folders f ON f.account_id = a.id JOIN user_folders uf ON uf.folder_id = f.id WHERE uf.user_id = $1 ORDER BY a.last_used_at DESC`, [userId]),
  getAccount: (id) => one(`SELECT * FROM accounts WHERE id = $1`, [id]),
  touchAccount: (ts, id) => query(`UPDATE accounts SET last_used_at = $1 WHERE id = $2`, [ts, id]),
  updateAccount: (a) =>
    query(`UPDATE accounts SET session=$1, is_premium=$2, label=$3, user_id=$4, username=$5 WHERE id=$6`, [
      a.session,
      a.is_premium,
      a.label,
      a.user_id,
      a.username,
      a.id,
    ]),
  deleteAccount: (id) => query(`DELETE FROM accounts WHERE id = $1`, [id]),

  addFolder: (f) =>
    query(`INSERT INTO folders (id,account_id,parent_id,title,peer_json,kind,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      f.id,
      f.account_id,
      f.parent_id,
      f.title,
      f.peer_json,
      f.kind,
      f.created_at,
    ]),
  foldersFor: (accountId) => query(`SELECT * FROM folders WHERE account_id = $1 ORDER BY kind DESC, lower(title)`, [accountId]),
  foldersForUser: (accountId, userId) => query(`SELECT f.* FROM folders f JOIN user_folders uf ON uf.folder_id = f.id WHERE f.account_id = $1 AND uf.user_id = $2 ORDER BY f.kind DESC, lower(f.title)`, [accountId, userId]),
  folderIdsForUser: (accountId, userId) => query(`SELECT f.id FROM folders f JOIN user_folders uf ON uf.folder_id = f.id WHERE f.account_id = $1 AND uf.user_id = $2`, [accountId, userId]),
  getFolder: (id, accountId) => one(`SELECT * FROM folders WHERE id = $1 AND account_id = $2`, [id, accountId]),
  getFolderForUser: (id, accountId, userId) => one(`SELECT f.* FROM folders f JOIN user_folders uf ON uf.folder_id = f.id WHERE f.id = $1 AND f.account_id = $2 AND uf.user_id = $3`, [id, accountId, userId]),
  renameFolder: (id, accountId, title) => query(`UPDATE folders SET title = $1 WHERE id = $2 AND account_id = $3`, [title, id, accountId]),
  deleteFolder: (id, accountId) => query(`DELETE FROM folders WHERE id = $1 AND account_id = $2`, [id, accountId]),

  addShare: (s) =>
    query(
      `INSERT INTO shares (id,account_id,peer_json,msg_id,msg_ids,multipart_id,name,mime,size,password_hash,expires_at,created_at,kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.id, s.account_id, s.peer_json, s.msg_id, s.msg_ids ? JSON.stringify(s.msg_ids) : null, s.multipart_id, s.name, s.mime, s.size, s.password_hash, s.expires_at, s.created_at, s.kind]
    ),
  getShare: (id) => one(`SELECT * FROM shares WHERE id = $1`, [id]),
  getShareByFile: (accountId, peerJson, msgId) =>
    one(`SELECT * FROM shares WHERE account_id = $1 AND peer_json = $2 AND msg_id = $3 ORDER BY created_at DESC LIMIT 1`, [accountId, peerJson, msgId]),
  deleteSharesByFile: (accountId, peerJson, msgId) =>
    query(`DELETE FROM shares WHERE account_id = $1 AND peer_json = $2 AND msg_id = $3`, [accountId, peerJson, msgId]),
  deleteFolderShares: (accountId, peerJson) => query(`DELETE FROM shares WHERE account_id = $1 AND peer_json = $2 AND kind = 'folder'`, [accountId, peerJson]),
  getFolderShare: (accountId, peerJson) =>
    one(`SELECT * FROM shares WHERE account_id = $1 AND peer_json = $2 AND kind = 'folder' LIMIT 1`, [accountId, peerJson]),
  incShareDownload: (id) => query(`UPDATE shares SET downloads = downloads + 1 WHERE id = $1`, [id]),
  listShares: () => query(`SELECT * FROM shares ORDER BY created_at DESC`),
  deleteShare: (id) => query(`DELETE FROM shares WHERE id = $1`, [id]),

  addApiKey: (k) =>
    query(`INSERT INTO api_keys (id,token_hash,label,account_id,created_at) VALUES ($1,$2,$3,$4,$5)`, [k.id, k.token_hash, k.label, k.account_id, k.created_at]),
  listApiKeys: () => query(`SELECT id, label, account_id, created_at FROM api_keys ORDER BY created_at DESC`),
  findApiKeyByHash: (hash) => one(`SELECT id, account_id FROM api_keys WHERE token_hash = $1`, [hash]),
  deleteApiKey: (id) => query(`DELETE FROM api_keys WHERE id = $1`, [id]),

  addUser: (u) => query(`INSERT INTO users (id,username,password_hash,role,created_at) VALUES ($1,$2,$3,$4,$5)`, [u.id, u.username, u.password_hash, u.role, u.created_at]),
  getUserByUsername: (username) => one(`SELECT * FROM users WHERE username = $1`, [username]),
  getUserById: (id) => one(`SELECT * FROM users WHERE id = $1`, [id]),
  listUsers: () => query(`SELECT id, username, role, created_at FROM users ORDER BY created_at`),
  updateUser: (u) => query(`UPDATE users SET password_hash = $1, role = $2 WHERE id = $3`, [u.password_hash, u.role, u.id]),
  deleteUser: (id) => query(`DELETE FROM users WHERE id = $1`, [id]),
  countUsers: () => one(`SELECT COUNT(*)::int AS c FROM users`),
  setUserFolders: async (userId, folderIds) => {
    await query(`DELETE FROM user_folders WHERE user_id = $1`, [userId]);
    for (const folderId of folderIds) await query(`INSERT INTO user_folders (user_id, folder_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, folderId]);
  },
  userFolderIds: (userId) => query(`SELECT folder_id FROM user_folders WHERE user_id = $1`, [userId]),

  addMultipart: (m) =>
    query(`INSERT INTO multipart_files (id,account_id,peer_json,name,mime,size,parts_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      m.id,
      m.account_id,
      m.peer_json,
      m.name,
      m.mime,
      m.size,
      m.parts_json,
      m.created_at,
    ]),
  getMultipart: (id) => one(`SELECT * FROM multipart_files WHERE id = $1`, [id]),
  listMultipart: (accountId, peerJson) => query(`SELECT * FROM multipart_files WHERE account_id = $1 AND peer_json = $2 ORDER BY created_at DESC`, [accountId, peerJson]),
  renameMultipart: (m) => query(`UPDATE multipart_files SET name = $1 WHERE id = $2`, [m.name, m.id]),
  updateMultipartParts: (m) => query(`UPDATE multipart_files SET parts_json = $1 WHERE id = $2`, [m.parts_json, m.id]),
  updateMultipart: (m) => query(`UPDATE multipart_files SET peer_json = $1 WHERE id = $2`, [m.peer_json, m.id]),
  deleteMultipart: (id) => query(`DELETE FROM multipart_files WHERE id = $1`, [id]),
  getShareByMultipart: (accountId, peerJson, multipartId) =>
    one(`SELECT * FROM shares WHERE account_id = $1 AND peer_json = $2 AND multipart_id = $3 ORDER BY created_at DESC LIMIT 1`, [accountId, peerJson, multipartId]),
  deleteSharesByMultipart: (multipartId) => query(`DELETE FROM shares WHERE multipart_id = $1`, [multipartId]),

  addSession: (s) =>
    query(`INSERT INTO sessions (sid,user_id,username,role,current_account_id,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      s.sid,
      s.user_id,
      s.username,
      s.role,
      s.current_account_id,
      s.created_at,
      s.expires_at,
    ]),
  getSession: (sid) => one(`SELECT * FROM sessions WHERE sid = $1`, [sid]),
  updateSessionRow: (s) => query(`UPDATE sessions SET current_account_id = $1 WHERE sid = $2`, [s.current_account_id, s.sid]),
  deleteSession: (sid) => query(`DELETE FROM sessions WHERE sid = $1`, [sid]),
  deleteExpiredSessions: (ts) => query(`DELETE FROM sessions WHERE expires_at < $1`, [ts]),
  deleteSessionsByUser: (userId) => query(`DELETE FROM sessions WHERE user_id = $1`, [userId]),
};

export default pool;

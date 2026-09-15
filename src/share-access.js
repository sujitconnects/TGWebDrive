// Pure share access-control logic, kept free of DB/Telegram/Express dependencies
// so it can be unit tested in isolation and reused by any route that needs it.

// Whether a given Telegram message id is actually covered by this share.
// - Folder shares expose every message in the shared peer (that's the point of a folder share).
// - Multi-file shares only expose ids listed in msg_ids.
// - Single-file shares only expose their own msg_id.
// - Multipart (split) shares have no single Telegram message id, so per-message
//   routes never apply to them.
// Malformed/missing data always denies access rather than throwing, so a bad DB
// row can't accidentally widen access.
export function isMsgAllowedForShare(s, msgId) {
  if (!s || s.multipart_id) return false;
  const id = Number(msgId);
  if (!Number.isFinite(id)) return false;
  if ((s.kind || "file") === "folder") return true;
  if (s.msg_ids != null) {
    let allowed;
    try {
      allowed = JSON.parse(s.msg_ids);
    } catch {
      return false;
    }
    if (!Array.isArray(allowed)) return false;
    return allowed.map(Number).includes(id);
  }
  if (s.msg_id != null) return Number(s.msg_id) === id;
  return false;
}

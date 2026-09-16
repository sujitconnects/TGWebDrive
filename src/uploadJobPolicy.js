// Pure upload-job state-machine + retry/recovery policy — kept free of DB/fs/express
// dependencies so it can be unit tested in isolation and reused everywhere the
// same decision needs to be made (route handlers, startup recovery sweep).

export const UPLOAD_JOB_STATUSES = ["queued", "uploading", "retrying", "completed", "failed", "cancelled"];
export const TERMINAL_UPLOAD_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

const VALID_TRANSITIONS = {
  queued: new Set(["uploading", "cancelled", "failed"]),
  uploading: new Set(["retrying", "completed", "failed", "cancelled"]),
  retrying: new Set(["uploading", "completed", "failed", "cancelled"]),
  completed: new Set([]),
  // A failed job may only move forward via the retry endpoint, back into "uploading".
  failed: new Set(["uploading"]),
  cancelled: new Set([]),
};

// Whether moving an upload job from `from` to `to` is a legal state transition.
// Used as an application-level guard before issuing any status-changing update,
// so e.g. a completed or cancelled job can never be silently resurrected.
export function canTransitionUploadJob(from, to) {
  return !!VALID_TRANSITIONS[from]?.has(to);
}

// Decide what to do with a job that was still non-terminal (queued/uploading/
// retrying) when the process last stopped — used both by the startup recovery
// sweep and by the retry endpoint (recomputed fresh each time, never trusted
// from a stored flag, since the temp file may be cleaned up later).
//
// Policy:
//  - no temp file left on disk -> permanently failed, nothing to retry.
//  - temp file exists but the client hadn't finished sending all bytes yet ->
//    the file is guaranteed incomplete/corrupt; permanently failed, and the
//    (unsafe) temp file must be deleted rather than ever reused.
//  - temp file exists AND was fully received (crash happened while it was
//    being sent on to Telegram) -> safe to retry from the same temp file.
export function classifyInterruptedUploadJob({ tmpExists, receivedBytes, totalBytes }) {
  if (!tmpExists) {
    return { retryable: false, deleteTmp: false, lastError: "Upload interrupted by a server restart; the temporary file is no longer available. Please re-upload." };
  }
  const total = Number(totalBytes) || 0;
  const received = Number(receivedBytes) || 0;
  const fullyReceived = total > 0 && received >= total;
  if (!fullyReceived) {
    return { retryable: false, deleteTmp: true, lastError: "Upload interrupted by a server restart before the file finished uploading. Please re-upload." };
  }
  return { retryable: true, deleteTmp: false, lastError: "Upload interrupted by a server restart while sending to Telegram." };
}

// Ownership/authorization: a job is only visible/actionable by an admin (for
// the currently selected account) or by the user who created it. API-key
// initiated jobs (user_id null) are therefore admin-only through this check —
// matching the existing convention that API keys are an admin-managed resource.
export function canAccessUploadJob(job, requester) {
  if (!job || !requester) return false;
  if (job.account_id !== requester.accountId) return false;
  if (requester.isAdmin) return true;
  return job.user_id != null && String(job.user_id) === String(requester.userId);
}

// A failed job can only be retried if it's still eligible per classifyInterruptedUploadJob
// re-evaluated against the *current* state of its temp file — never trust a stale flag.
export function isUploadJobRetryEligible(job, { tmpExists }) {
  if (!job || job.status !== "failed") return false;
  if (job.multipart_id) return false; // multipart retry-from-scratch is out of scope; re-upload instead
  return classifyInterruptedUploadJob({ tmpExists, receivedBytes: job.received_bytes, totalBytes: job.total_bytes }).retryable;
}

// Whether enough time has passed to persist another progress update to the DB —
// avoids a write per chunk while still keeping stored progress reasonably fresh.
export function shouldPersistUploadProgress(lastPersistedAt, now, intervalMs = 1000) {
  return now - lastPersistedAt > intervalMs;
}

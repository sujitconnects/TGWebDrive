// Generic, dependency-free retry helper for Telegram RPC calls (kept free of
// db/config/express imports so it can be unit tested in isolation).

// Matches Telegram's "please wait N seconds" throttling response, e.g. "FLOOD_WAIT_30".
export function getFloodWaitSeconds(err) {
  if (!err) return null;
  const msg = String(err.errorMessage || err.message || "");
  const m = /FLOOD_WAIT_(\d+)/i.exec(msg);
  return m ? Number(m[1]) : null;
}

// Node/socket-level errors that are inherently transient.
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

// Known-permanent Telegram RPC error messages — retrying these can never succeed,
// so they must short-circuit even though we default unknown errors to "no retry".
const PERMANENT_MESSAGE_PATTERNS = [
  /^AUTH_KEY/i,
  /^SESSION_/i,
  /^API_ID_/i,
  /^API_HASH/i,
  /^PHONE_/i,
  /^PEER_ID_INVALID/i,
  /^CHANNEL_INVALID/i,
  /^CHANNEL_PRIVATE/i,
  /^CHAT_ID_INVALID/i,
  /^CHAT_WRITE_FORBIDDEN/i,
  /^CHAT_ADMIN_REQUIRED/i,
  /^USER_BANNED_IN_CHANNEL/i,
  /^USER_DEACTIVATED/i,
  /^FILE_PART/i,
  /^FILE_ID_INVALID/i,
  /^FILE_REFERENCE/i,
  /^MEDIA_EMPTY/i,
  /^MEDIA_CAPTION_TOO_LONG/i,
  /^MEDIA_INVALID/i,
  /^PHOTO_INVALID/i,
  /^PHOTO_EXT_INVALID/i,
  /^FILE_TYPE_INVALID/i,
  /^ACCESS_HASH_INVALID/i,
  /PERMISSION/i,
  /^UNAUTHORIZED/i,
  /^FORBIDDEN/i,
];

// Known-transient Telegram/network conditions worth retrying.
const TRANSIENT_MESSAGE_PATTERNS = [
  /^TIMEOUT/i,
  /^INTERNAL/i,
  /^-?50\d(_|$)/,
  /^-?503/,
  /disconnect/i,
  /connection closed/i,
  /connection reset/i,
  /reset by peer/i,
  /socket closed/i,
  /unexpected.*close/i,
  /not connected/i,
  /^CONNECTION/i,
  /timed? ?out/i,
  /closed unexpectedly/i,
  /broken pipe/i,
  /read econnreset/i,
  /econnreset/i,
];

// Whether a Telegram/network error is worth retrying. FLOOD_WAIT is handled
// separately by the caller (it's "retryable" but on its own timer, not backoff).
// Unmatched/unknown errors default to *not* retryable — masking an unexpected
// permanent failure behind retries would be worse than failing fast.
export function isRetryableTelegramError(err) {
  if (!err) return false;
  if (getFloodWaitSeconds(err) != null) return true;
  const code = err.code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) return true;
  const msg = String(err.errorMessage || err.message || "");
  if (PERMANENT_MESSAGE_PATTERNS.some((re) => re.test(msg))) return false;
  if (TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(msg))) return true;
  if (typeof code === "number" && code >= 500) return true;
  return false;
}

// Exponential backoff with "full jitter": a random delay between 0 and the
// capped exponential value, so concurrent retries don't all wake up at once.
export function computeBackoffDelayMs(attemptIndex, baseMs, maxMs, random = Math.random) {
  const capped = Math.min(maxMs, baseMs * Math.pow(2, attemptIndex));
  return Math.floor(random() * capped);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thrown when Telegram's FLOOD_WAIT exceeds the configured maximum — deliberately
// not tied to any HTTP framework so this module has no db/express dependency;
// callers should catch it and translate it into their own user-facing error type.
export class FloodWaitExceededError extends Error {
  constructor(seconds, maxSeconds) {
    super(`Telegram asked to wait ${seconds}s before retrying, which exceeds the configured maximum of ${maxSeconds}s.`);
    this.name = "FloodWaitExceededError";
    this.seconds = seconds;
    this.maxSeconds = maxSeconds;
  }
}

// Thrown when the caller's `shouldAbort()` reports true — used for cooperative
// cancellation (e.g. a user-requested cancel of an in-progress upload).
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
  }
}

// Retries `operation` with exponential backoff + jitter, honouring Telegram's
// FLOOD_WAIT responses on their own timer (capped at maxFloodWaitSeconds).
// Never retries permanent errors, and never retries past maxAttempts. If a
// `shouldAbort()` predicate is supplied, it's checked before each attempt and
// before each retry delay so a cancellation request never has to wait for a
// full backoff sleep before taking effect.
export async function withTelegramRetry(
  operation,
  { maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 30000, maxFloodWaitSeconds = 300, onRetry, sleep = defaultSleep, random = Math.random, shouldAbort } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shouldAbort && shouldAbort()) throw new UploadCancelledError();
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt >= maxAttempts;
      const floodWaitSeconds = getFloodWaitSeconds(err);
      if (floodWaitSeconds != null) {
        if (floodWaitSeconds > maxFloodWaitSeconds) throw new FloodWaitExceededError(floodWaitSeconds, maxFloodWaitSeconds);
        if (isLastAttempt) throw err;
        if (shouldAbort && shouldAbort()) throw new UploadCancelledError();
        const delayMs = floodWaitSeconds * 1000;
        if (onRetry) await onRetry({ attempt, error: err, delayMs, reason: "flood_wait" });
        await sleep(delayMs);
        continue;
      }
      if (isLastAttempt || !isRetryableTelegramError(err)) throw err;
      if (shouldAbort && shouldAbort()) throw new UploadCancelledError();
      const delayMs = computeBackoffDelayMs(attempt - 1, baseDelayMs, maxDelayMs, random);
      if (onRetry) await onRetry({ attempt, error: err, delayMs, reason: "transient" });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

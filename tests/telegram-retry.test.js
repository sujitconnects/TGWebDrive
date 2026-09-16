import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  getFloodWaitSeconds,
  isRetryableTelegramError,
  computeBackoffDelayMs,
  withTelegramRetry,
  FloodWaitExceededError,
  UploadCancelledError,
} from '../src/tg/retry.js';

// A sleep stub that resolves immediately but records the requested delays,
// so tests run fast while still asserting on backoff timing.
function recordingSleep(log) {
  return async (ms) => {
    log.push(ms);
  };
}

function rpcError(errorMessage, code) {
  const e = new Error(errorMessage);
  e.errorMessage = errorMessage;
  if (code !== undefined) e.code = code;
  return e;
}

function networkError(code) {
  const e = new Error(`simulated ${code}`);
  e.code = code;
  return e;
}

describe('getFloodWaitSeconds', () => {
  test('extracts seconds from a FLOOD_WAIT_n error message', () => {
    assert.equal(getFloodWaitSeconds(rpcError('FLOOD_WAIT_30')), 30);
    assert.equal(getFloodWaitSeconds(rpcError('FLOOD_WAIT_600')), 600);
  });

  test('returns null for non-flood errors and missing input', () => {
    assert.equal(getFloodWaitSeconds(rpcError('CHANNEL_INVALID')), null);
    assert.equal(getFloodWaitSeconds(null), null);
    assert.equal(getFloodWaitSeconds(undefined), null);
  });
});

describe('isRetryableTelegramError', () => {
  test('treats common transient network errors as retryable', () => {
    assert.equal(isRetryableTelegramError(networkError('ECONNRESET')), true);
    assert.equal(isRetryableTelegramError(networkError('ETIMEDOUT')), true);
    assert.equal(isRetryableTelegramError(networkError('ECONNREFUSED')), true);
  });

  test('treats Telegram 5xx-style / internal / timeout errors as retryable', () => {
    assert.equal(isRetryableTelegramError(rpcError('INTERNAL_SERVER_ERROR', 500)), true);
    assert.equal(isRetryableTelegramError(rpcError('TIMEOUT')), true);
    assert.equal(isRetryableTelegramError(rpcError('-503')), true);
    assert.equal(isRetryableTelegramError(rpcError('socket disconnected')), true);
  });

  test('a FLOOD_WAIT error is considered retryable (handled on its own timer)', () => {
    assert.equal(isRetryableTelegramError(rpcError('FLOOD_WAIT_5')), true);
  });

  test('permanent errors are never retryable: invalid credentials, invalid chat/channel, permissions, invalid file data', () => {
    assert.equal(isRetryableTelegramError(rpcError('API_ID_INVALID')), false);
    assert.equal(isRetryableTelegramError(rpcError('AUTH_KEY_UNREGISTERED')), false);
    assert.equal(isRetryableTelegramError(rpcError('CHANNEL_INVALID')), false);
    assert.equal(isRetryableTelegramError(rpcError('CHAT_ID_INVALID')), false);
    assert.equal(isRetryableTelegramError(rpcError('CHAT_WRITE_FORBIDDEN')), false);
    assert.equal(isRetryableTelegramError(rpcError('FILE_PARTS_INVALID')), false);
    assert.equal(isRetryableTelegramError(rpcError('FILE_TYPE_INVALID')), false);
    assert.equal(isRetryableTelegramError(rpcError('MEDIA_EMPTY')), false);
  });

  test('unknown/unrecognized errors default to not retryable', () => {
    assert.equal(isRetryableTelegramError(rpcError('SOME_BRAND_NEW_ERROR_CODE')), false);
    assert.equal(isRetryableTelegramError(new Error('totally generic error')), false);
    assert.equal(isRetryableTelegramError(null), false);
  });
});

describe('computeBackoffDelayMs (exponential backoff + jitter)', () => {
  test('grows exponentially with attempt index, capped at maxMs', () => {
    const base = 100;
    const max = 10000;
    // With random() = 1 (upper bound), delay == the capped exponential value.
    assert.equal(computeBackoffDelayMs(0, base, max, () => 1), 100); // 100 * 2^0
    assert.equal(computeBackoffDelayMs(1, base, max, () => 1), 200); // 100 * 2^1
    assert.equal(computeBackoffDelayMs(2, base, max, () => 1), 400); // 100 * 2^2
    assert.equal(computeBackoffDelayMs(10, base, max, () => 1), max); // capped
  });

  test('jitter stays within [0, cappedExponentialValue]', () => {
    const base = 50;
    const max = 5000;
    for (const attempt of [0, 1, 2, 3, 4, 5]) {
      const capped = Math.min(max, base * 2 ** attempt);
      const low = computeBackoffDelayMs(attempt, base, max, () => 0);
      const high = computeBackoffDelayMs(attempt, base, max, () => 0.999999);
      assert.equal(low, 0);
      assert.ok(high <= capped, `high=${high} should be <= capped=${capped}`);
      assert.ok(high >= 0);
    }
  });
});

describe('withTelegramRetry', () => {
  test('succeeds on the first attempt without ever sleeping', async () => {
    const sleepLog = [];
    const result = await withTelegramRetry(async () => 'ok', { sleep: recordingSleep(sleepLog) });
    assert.equal(result, 'ok');
    assert.deepEqual(sleepLog, []);
  });

  test('succeeds after a retryable failure', async () => {
    const sleepLog = [];
    let calls = 0;
    const result = await withTelegramRetry(
      async () => {
        calls++;
        if (calls === 1) throw networkError('ECONNRESET');
        return 'ok-after-retry';
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: recordingSleep(sleepLog), random: () => 0.5 }
    );
    assert.equal(result, 'ok-after-retry');
    assert.equal(calls, 2);
    assert.equal(sleepLog.length, 1);
  });

  test('retries a retryable network error the configured number of times, then throws', async () => {
    const sleepLog = [];
    let calls = 0;
    await assert.rejects(
      () =>
        withTelegramRetry(
          async () => {
            calls++;
            throw networkError('ETIMEDOUT');
          },
          { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 50, sleep: recordingSleep(sleepLog), random: () => 0.5 }
        ),
      /simulated ETIMEDOUT/
    );
    assert.equal(calls, 4);
    assert.equal(sleepLog.length, 3); // slept between attempts 1-2, 2-3, 3-4, not after the last
  });

  test('does not retry a permanent error, even on the very first attempt', async () => {
    const sleepLog = [];
    let calls = 0;
    await assert.rejects(
      () =>
        withTelegramRetry(
          async () => {
            calls++;
            throw rpcError('CHANNEL_INVALID');
          },
          { maxAttempts: 5, sleep: recordingSleep(sleepLog) }
        ),
      /CHANNEL_INVALID/
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleepLog, []);
  });

  test('maximum attempts reached surfaces the last error', async () => {
    let calls = 0;
    const err = networkError('ECONNRESET');
    await assert.rejects(
      () =>
        withTelegramRetry(
          async () => {
            calls++;
            throw err;
          },
          { maxAttempts: 2, sleep: async () => {} }
        ),
      (thrown) => thrown === err
    );
    assert.equal(calls, 2);
  });

  test('a FLOOD_WAIT below the configured maximum sleeps for the requested duration and retries', async () => {
    const sleepLog = [];
    let calls = 0;
    const result = await withTelegramRetry(
      async () => {
        calls++;
        if (calls === 1) throw rpcError('FLOOD_WAIT_5');
        return 'ok';
      },
      { maxAttempts: 3, maxFloodWaitSeconds: 60, sleep: recordingSleep(sleepLog) }
    );
    assert.equal(result, 'ok');
    assert.deepEqual(sleepLog, [5000]);
  });

  test('a FLOOD_WAIT above the configured maximum throws FloodWaitExceededError without sleeping', async () => {
    const sleepLog = [];
    let calls = 0;
    await assert.rejects(
      () =>
        withTelegramRetry(
          async () => {
            calls++;
            throw rpcError('FLOOD_WAIT_600');
          },
          { maxAttempts: 5, maxFloodWaitSeconds: 60, sleep: recordingSleep(sleepLog) }
        ),
      (err) => err instanceof FloodWaitExceededError && err.seconds === 600 && err.maxSeconds === 60
    );
    assert.equal(calls, 1); // never worth retrying without waiting past the cap
    assert.deepEqual(sleepLog, []);
  });

  test('never sleeps for an unbounded amount of time — flood wait is always capped by maxFloodWaitSeconds', async () => {
    const sleepLog = [];
    await assert.rejects(() =>
      withTelegramRetry(
        async () => {
          throw rpcError('FLOOD_WAIT_999999');
        },
        { maxFloodWaitSeconds: 300, sleep: recordingSleep(sleepLog) }
      )
    );
    assert.deepEqual(sleepLog, []);
  });
});

describe('withTelegramRetry cooperative cancellation (shouldAbort)', () => {
  test('aborts before the first attempt if shouldAbort is already true', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withTelegramRetry(
          async () => {
            calls++;
            return 'should not run';
          },
          { shouldAbort: () => true, sleep: async () => {} }
        ),
      (err) => err instanceof UploadCancelledError
    );
    assert.equal(calls, 0);
  });

  test('aborts before sleeping between retries once shouldAbort flips to true', async () => {
    const sleepLog = [];
    let calls = 0;
    let cancelRequested = false;
    await assert.rejects(
      () =>
        withTelegramRetry(
          async () => {
            calls++;
            cancelRequested = true; // simulate a cancel request arriving right after the first failure
            throw networkError('ECONNRESET');
          },
          { maxAttempts: 5, shouldAbort: () => cancelRequested, sleep: recordingSleep(sleepLog) }
        ),
      (err) => err instanceof UploadCancelledError
    );
    assert.equal(calls, 1); // never got to attempt 2
    assert.deepEqual(sleepLog, []); // never slept for a retry that was about to be cancelled
  });

  test('does not abort when shouldAbort stays false throughout', async () => {
    const result = await withTelegramRetry(async () => 'ok', { shouldAbort: () => false, sleep: async () => {} });
    assert.equal(result, 'ok');
  });
});

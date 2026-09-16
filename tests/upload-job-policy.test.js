import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  UPLOAD_JOB_STATUSES,
  canTransitionUploadJob,
  classifyInterruptedUploadJob,
  canAccessUploadJob,
  isUploadJobRetryEligible,
  shouldPersistUploadProgress,
} from '../src/uploadJobPolicy.js';

describe('upload job creation shape', () => {
  test('the allowed status enum matches the required six values', () => {
    assert.deepEqual(UPLOAD_JOB_STATUSES, ['queued', 'uploading', 'retrying', 'completed', 'failed', 'cancelled']);
  });
});

describe('canTransitionUploadJob (status transitions)', () => {
  test('a freshly queued job may start uploading, be cancelled, or fail outright', () => {
    assert.equal(canTransitionUploadJob('queued', 'uploading'), true);
    assert.equal(canTransitionUploadJob('queued', 'cancelled'), true);
    assert.equal(canTransitionUploadJob('queued', 'failed'), true);
    assert.equal(canTransitionUploadJob('queued', 'completed'), false);
  });

  test('an uploading job may retry, complete, fail, or be cancelled', () => {
    for (const to of ['retrying', 'completed', 'failed', 'cancelled']) {
      assert.equal(canTransitionUploadJob('uploading', to), true);
    }
    assert.equal(canTransitionUploadJob('uploading', 'queued'), false);
  });

  test('a retrying job behaves like uploading (can go back to uploading, complete, fail, or cancel)', () => {
    assert.equal(canTransitionUploadJob('retrying', 'uploading'), true);
    assert.equal(canTransitionUploadJob('retrying', 'completed'), true);
    assert.equal(canTransitionUploadJob('retrying', 'failed'), true);
    assert.equal(canTransitionUploadJob('retrying', 'cancelled'), true);
  });

  test('a failed job can only move forward via retry, back into uploading', () => {
    assert.equal(canTransitionUploadJob('failed', 'uploading'), true);
    assert.equal(canTransitionUploadJob('failed', 'completed'), false);
    assert.equal(canTransitionUploadJob('failed', 'retrying'), false);
    assert.equal(canTransitionUploadJob('failed', 'cancelled'), false);
  });

  test('completed and cancelled are terminal — no transitions out are allowed (cannot be re-uploaded)', () => {
    for (const to of UPLOAD_JOB_STATUSES) {
      assert.equal(canTransitionUploadJob('completed', to), false);
      assert.equal(canTransitionUploadJob('cancelled', to), false);
    }
  });

  test('an unknown "from" status is never a valid source of a transition', () => {
    assert.equal(canTransitionUploadJob('bogus', 'uploading'), false);
  });
});

describe('classifyInterruptedUploadJob (startup recovery policy)', () => {
  test('missing temp file after restart -> permanently failed, nothing to delete', () => {
    const r = classifyInterruptedUploadJob({ tmpExists: false, receivedBytes: 500, totalBytes: 1000 });
    assert.equal(r.retryable, false);
    assert.equal(r.deleteTmp, false);
    assert.match(r.lastError, /no longer available/i);
  });

  test('temp file exists but was not fully received -> permanently failed, unsafe temp file is deleted', () => {
    const r = classifyInterruptedUploadJob({ tmpExists: true, receivedBytes: 500, totalBytes: 1000 });
    assert.equal(r.retryable, false);
    assert.equal(r.deleteTmp, true);
    assert.match(r.lastError, /before the file finished uploading/i);
  });

  test('temp file exists and was fully received -> retryable, temp file preserved', () => {
    const r = classifyInterruptedUploadJob({ tmpExists: true, receivedBytes: 1000, totalBytes: 1000 });
    assert.equal(r.retryable, true);
    assert.equal(r.deleteTmp, false);
    assert.match(r.lastError, /sending to Telegram/i);
  });

  test('receivedBytes greater than totalBytes still counts as fully received', () => {
    const r = classifyInterruptedUploadJob({ tmpExists: true, receivedBytes: 1200, totalBytes: 1000 });
    assert.equal(r.retryable, true);
  });

  test('a zero/unknown totalBytes is treated as not-fully-received (cannot safely retry)', () => {
    const r = classifyInterruptedUploadJob({ tmpExists: true, receivedBytes: 0, totalBytes: 0 });
    assert.equal(r.retryable, false);
    assert.equal(r.deleteTmp, true);
  });
});

describe('canAccessUploadJob (ownership isolation / authorization)', () => {
  const job = { account_id: 'acc1', user_id: 'user1' };

  test('the owning user can access their own job', () => {
    assert.equal(canAccessUploadJob(job, { accountId: 'acc1', userId: 'user1', isAdmin: false }), true);
  });

  test('a different user on the same account cannot access someone else\'s job', () => {
    assert.equal(canAccessUploadJob(job, { accountId: 'acc1', userId: 'user2', isAdmin: false }), false);
  });

  test('a user on a different (currently selected) account cannot access the job even if user_id matches', () => {
    assert.equal(canAccessUploadJob(job, { accountId: 'acc2', userId: 'user1', isAdmin: false }), false);
  });

  test('an admin can access any job for the currently selected account', () => {
    assert.equal(canAccessUploadJob(job, { accountId: 'acc1', userId: 'someone-else', isAdmin: true }), true);
  });

  test('an admin on a different account cannot access the job (account boundary still applies)', () => {
    assert.equal(canAccessUploadJob(job, { accountId: 'acc2', userId: 'someone-else', isAdmin: true }), false);
  });

  test('an API-key-initiated job (user_id null) is only visible to admins, not to any regular user', () => {
    const apiJob = { account_id: 'acc1', user_id: null };
    assert.equal(canAccessUploadJob(apiJob, { accountId: 'acc1', userId: 'user1', isAdmin: false }), false);
    assert.equal(canAccessUploadJob(apiJob, { accountId: 'acc1', userId: 'user1', isAdmin: true }), true);
  });

  test('missing job or requester is denied safely', () => {
    assert.equal(canAccessUploadJob(null, { accountId: 'acc1', userId: 'user1', isAdmin: false }), false);
    assert.equal(canAccessUploadJob(job, null), false);
  });
});

describe('isUploadJobRetryEligible (retry a failed job where safe)', () => {
  test('a failed, fully-received, non-multipart job with a surviving temp file is retryable', () => {
    const job = { status: 'failed', received_bytes: 1000, total_bytes: 1000, multipart_id: null };
    assert.equal(isUploadJobRetryEligible(job, { tmpExists: true }), true);
  });

  test('a failed job whose temp file no longer exists is never auto-retryable', () => {
    const job = { status: 'failed', received_bytes: 1000, total_bytes: 1000, multipart_id: null };
    assert.equal(isUploadJobRetryEligible(job, { tmpExists: false }), false);
  });

  test('a job that is not in the failed status cannot be retried (completed cannot be re-uploaded)', () => {
    const completed = { status: 'completed', received_bytes: 1000, total_bytes: 1000, multipart_id: null };
    assert.equal(isUploadJobRetryEligible(completed, { tmpExists: true }), false);
    const cancelled = { status: 'cancelled', received_bytes: 1000, total_bytes: 1000, multipart_id: null };
    assert.equal(isUploadJobRetryEligible(cancelled, { tmpExists: true }), false);
    const queued = { status: 'queued', received_bytes: 0, total_bytes: 1000, multipart_id: null };
    assert.equal(isUploadJobRetryEligible(queued, { tmpExists: true }), false);
  });

  test('a multipart job is never retried in place (out of scope; must be re-uploaded)', () => {
    const job = { status: 'failed', received_bytes: 1000, total_bytes: 1000, multipart_id: 'mp_abc' };
    assert.equal(isUploadJobRetryEligible(job, { tmpExists: true }), false);
  });

  test('a failed job that was interrupted before full receipt is never retryable even if a temp file happens to exist', () => {
    const job = { status: 'failed', received_bytes: 400, total_bytes: 1000, multipart_id: null };
    assert.equal(isUploadJobRetryEligible(job, { tmpExists: true }), false);
  });
});

describe('shouldPersistUploadProgress (progress update throttling)', () => {
  test('does not persist again before the interval has elapsed', () => {
    assert.equal(shouldPersistUploadProgress(1000, 1500, 1000), false);
  });

  test('persists once the interval has elapsed', () => {
    assert.equal(shouldPersistUploadProgress(1000, 2001, 1000), true);
  });

  test('uses a sensible default interval when none is supplied', () => {
    assert.equal(shouldPersistUploadProgress(0, 500), false);
    assert.equal(shouldPersistUploadProgress(0, 1500), true);
  });
});

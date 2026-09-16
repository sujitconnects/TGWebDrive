import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { requestUploadJobCancel, isUploadJobCancelRequested, clearUploadJobCancel } from '../src/uploadJobCancel.js';

describe('upload job cooperative cancellation flags', () => {
  test('a job is not cancelled until requested', () => {
    assert.equal(isUploadJobCancelRequested('job-a'), false);
  });

  test('requestUploadJobCancel marks a job as cancel-requested', () => {
    requestUploadJobCancel('job-b');
    assert.equal(isUploadJobCancelRequested('job-b'), true);
    clearUploadJobCancel('job-b');
  });

  test('clearUploadJobCancel resets the flag (e.g. once the request handler has finished)', () => {
    requestUploadJobCancel('job-c');
    assert.equal(isUploadJobCancelRequested('job-c'), true);
    clearUploadJobCancel('job-c');
    assert.equal(isUploadJobCancelRequested('job-c'), false);
  });

  test('cancellation flags are isolated per job id', () => {
    requestUploadJobCancel('job-d');
    assert.equal(isUploadJobCancelRequested('job-d'), true);
    assert.equal(isUploadJobCancelRequested('job-e'), false);
    clearUploadJobCancel('job-d');
  });

  test('requesting/clearing with a falsy id is a safe no-op', () => {
    assert.doesNotThrow(() => requestUploadJobCancel(undefined));
    assert.doesNotThrow(() => requestUploadJobCancel(''));
    assert.doesNotThrow(() => clearUploadJobCancel(undefined));
    assert.equal(isUploadJobCancelRequested(undefined), false);
    assert.equal(isUploadJobCancelRequested(''), false);
  });
});

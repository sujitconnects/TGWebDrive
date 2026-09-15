import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isMsgAllowedForShare } from '../src/share-access.js';

describe('share per-file access control (IDOR fix)', () => {
  test('single-file share allows only the original message id', () => {
    const share = { kind: 'file', msg_id: 42, msg_ids: null, multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 42), true);
    assert.equal(isMsgAllowedForShare(share, '42'), true);
  });

  test('single-file share denies any other message id', () => {
    const share = { kind: 'file', msg_id: 42, msg_ids: null, multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 43), false);
    assert.equal(isMsgAllowedForShare(share, 1), false);
  });

  test('multi-file share allows only ids listed in msg_ids', () => {
    const share = { kind: 'file', msg_id: null, msg_ids: JSON.stringify([10, 11, 12]), multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 10), true);
    assert.equal(isMsgAllowedForShare(share, 11), true);
    assert.equal(isMsgAllowedForShare(share, 12), true);
  });

  test('multi-file share denies an id not included in the share (the original IDOR)', () => {
    const share = { kind: 'file', msg_id: null, msg_ids: JSON.stringify([10, 11, 12]), multipart_id: null };
    // An attacker guessing nearby message ids in the same channel must be denied.
    assert.equal(isMsgAllowedForShare(share, 13), false);
    assert.equal(isMsgAllowedForShare(share, 9999), false);
  });

  test('folder share allows any message id (that is the point of sharing a folder)', () => {
    const share = { kind: 'folder', msg_id: null, msg_ids: null, multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 1), true);
    assert.equal(isMsgAllowedForShare(share, 999999), true);
  });

  test('malformed msg_ids JSON denies access instead of throwing', () => {
    const share = { kind: 'file', msg_id: null, msg_ids: '{not valid json', multipart_id: null };
    assert.doesNotThrow(() => isMsgAllowedForShare(share, 10));
    assert.equal(isMsgAllowedForShare(share, 10), false);
  });

  test('msg_ids that is valid JSON but not an array denies access', () => {
    const share = { kind: 'file', msg_id: null, msg_ids: JSON.stringify({ 10: true }), multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 10), false);
  });

  test('a share with neither msg_id nor msg_ids (and not a folder) denies access', () => {
    const share = { kind: 'file', msg_id: null, msg_ids: null, multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 1), false);
  });

  test('multipart (split file) shares never match the per-message route', () => {
    const share = { kind: 'file', msg_id: null, msg_ids: null, multipart_id: 'mp_abc123' };
    assert.equal(isMsgAllowedForShare(share, 1), false);
  });

  test('non-numeric or missing msgId is denied', () => {
    const share = { kind: 'file', msg_id: 42, msg_ids: null, multipart_id: null };
    assert.equal(isMsgAllowedForShare(share, 'not-a-number'), false);
    assert.equal(isMsgAllowedForShare(share, undefined), false);
  });

  test('a null/undefined share is denied safely', () => {
    assert.equal(isMsgAllowedForShare(null, 1), false);
    assert.equal(isMsgAllowedForShare(undefined, 1), false);
  });
});

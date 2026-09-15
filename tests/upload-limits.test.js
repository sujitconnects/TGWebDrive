import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { checkDeclaredUploadSize, wouldExceedUploadLimit } from '../src/util.js';

const ONE_MB = 1024 * 1024;
const MAX = 10 * ONE_MB;

describe('upload size limit enforcement', () => {
  test('a file below the limit is allowed', () => {
    const r = checkDeclaredUploadSize(String(5 * ONE_MB), MAX);
    assert.equal(r.ok, true);
    assert.equal(r.declared, true);
    assert.equal(r.size, 5 * ONE_MB);
  });

  test('a file exactly at the limit is allowed (inclusive boundary)', () => {
    const r = checkDeclaredUploadSize(String(MAX), MAX);
    assert.equal(r.ok, true);
    assert.equal(r.size, MAX);
  });

  test('a file above the limit is rejected', () => {
    const r = checkDeclaredUploadSize(String(MAX + 1), MAX);
    assert.equal(r.ok, false);
    assert.equal(r.declared, true);
  });

  test('a missing x-filesize header is treated as unknown, not rejected outright', () => {
    const r1 = checkDeclaredUploadSize(undefined, MAX);
    const r2 = checkDeclaredUploadSize('', MAX);
    assert.equal(r1.ok, true);
    assert.equal(r1.declared, false);
    assert.equal(r2.ok, true);
    assert.equal(r2.declared, false);
  });

  test('an invalid (non-numeric or negative) x-filesize header is treated as unknown', () => {
    assert.equal(checkDeclaredUploadSize('not-a-number', MAX).declared, false);
    assert.equal(checkDeclaredUploadSize('-5', MAX).declared, false);
    assert.equal(checkDeclaredUploadSize('NaN', MAX).declared, false);
  });

  test('streaming guard flags the exact chunk that would push received bytes over the limit', () => {
    // Client declared a small size but the actual stream is larger — the header
    // must never be the only protection.
    assert.equal(wouldExceedUploadLimit(MAX - 10, 5, MAX), false);
    assert.equal(wouldExceedUploadLimit(MAX - 10, 11, MAX), true);
    assert.equal(wouldExceedUploadLimit(0, MAX, MAX), false); // exactly at limit is still allowed
    assert.equal(wouldExceedUploadLimit(0, MAX + 1, MAX), true);
  });
});

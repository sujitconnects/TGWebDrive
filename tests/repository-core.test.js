import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  uid,
  shortId,
  hashPassword,
  verifyPassword,
  token,
  fmtBytes,
  fmtRate,
  safeFilename,
  tempPath,
  isImage,
  isVideo,
  isAudio,
  classify,
  extOf,
} from '../src/util.js';
import { subscribe, publish, finish, fail } from '../src/jobs.js';

describe('repository core utilities', () => {
  test('uid generates a stable 16-character UUID-derived id', () => {
    const value = uid();
    assert.equal(typeof value, 'string');
    assert.equal(value.length, 16);
    assert.match(value, /^[a-f0-9]+$/i);
  });

  test('shortId generates predictable-length ids and accepts custom length', () => {
    const defaultValue = shortId();
    const customValue = shortId(12);
    assert.equal(typeof defaultValue, 'string');
    assert.equal(defaultValue.length, 8);
    assert.equal(customValue.length, 12);
    assert.match(customValue, /^[a-z0-9]+$/);
  });

  test('hashPassword returns null for blank input and verifyPassword works with the stored hash', () => {
    assert.equal(hashPassword(''), null);
    assert.equal(hashPassword(null), null);

    const plain = 'super-secret-password';
    const hash = hashPassword(plain);
    assert.ok(typeof hash === 'string' && hash.startsWith('scrypt$'));
    assert.equal(verifyPassword(plain, hash), true);
    assert.equal(verifyPassword('wrong', hash), false);
    assert.equal(verifyPassword('', hash), false);
  });

  test('token creates a hex token of the requested byte length', () => {
    const value = token(16);
    assert.equal(typeof value, 'string');
    assert.equal(value.length, 32);
    assert.match(value, /^[a-f0-9]+$/);
  });

  test('fmtBytes formats byte sizes and invalid values safely', () => {
    assert.equal(fmtBytes(0), '0 B');
    assert.equal(fmtBytes(1024), '1.0 KB');
    assert.equal(fmtBytes(1024 * 1024), '1.0 MB');
    assert.equal(fmtBytes(null), '—');
    assert.equal(fmtBytes(Number.NaN), '—');
  });

  test('fmtRate appends the per-second unit suffix', () => {
    assert.equal(fmtRate(2048), '2.0 KB/s');
    assert.equal(fmtRate(0), '0 B/s');
  });

  test('safeFilename strips unsupported characters, normalizes whitespace, and avoids empty names', () => {
    assert.equal(safeFilename('report/report.pdf'), 'report_report.pdf');
    assert.equal(safeFilename('  My   File .txt  '), 'My File .txt');
    assert.equal(safeFilename('<<<bad:<>|name>>>.txt'), '___bad____name___.txt');
    assert.equal(safeFilename('   '), 'file');
    assert.equal(safeFilename(''), 'file');
  });

  test('tempPath produces a temp file path under /tmp with the given prefix', () => {
    const path = tempPath('demo');
    assert.match(path, /^\/tmp\/demo-/);
    assert.ok(path.includes('demo-'));
  });

  test('mime classifiers identify common file types correctly', () => {
    assert.equal(isImage('image/png'), true);
    assert.equal(isImage('application/pdf'), false);
    assert.equal(isVideo('video/mp4'), true);
    assert.equal(isVideo('image/jpeg'), false);
    assert.equal(isAudio('audio/mpeg'), true);
    assert.equal(isAudio('application/ogg'), true);
  });

  test('classify maps filenames and mime types to drive categories', () => {
    assert.equal(classify('image/png', 'photo.png'), 'image');
    assert.equal(classify('video/mp4', 'clip.mp4'), 'video');
    assert.equal(classify('audio/mpeg', 'song.mp3'), 'audio');
    assert.equal(classify('application/pdf', 'report.pdf'), 'pdf');
    assert.equal(classify('application/zip', 'backup.zip'), 'archive');
    assert.equal(classify('text/plain', 'notes.txt'), 'text');
    assert.equal(classify('application/octet-stream', 'script.bin'), 'file');
  });

  test('extOf returns lowercase file extension or empty string', () => {
    assert.equal(extOf('report.PDF'), 'pdf');
    assert.equal(extOf('archive.tar.gz'), 'gz');
    assert.equal(extOf('README'), '');
    assert.equal(extOf(''), '');
  });
});

describe('job pub/sub helpers', () => {
  test('subscribe and publish deliver messages to registered listeners', () => {
    const calls = [];
    const unsubscribe = subscribe('job-1', (data) => calls.push(data));

    publish('job-1', { phase: 'receiving', received: 10 });
    publish('job-1', { phase: 'sending', uploaded: 20 });

    unsubscribe();
    publish('job-1', { phase: 'done' });

    assert.deepEqual(calls, [
      { phase: 'receiving', received: 10 },
      { phase: 'sending', uploaded: 20 },
    ]);
  });

  test('finish sends a done payload and removes the subscription set', () => {
    const calls = [];
    subscribe('job-2', (data) => calls.push(data));
    finish('job-2', { id: 'abc', name: 'demo.txt' });
    publish('job-2', { phase: 'late' });

    assert.deepEqual(calls, [{ id: 'abc', name: 'demo.txt', done: true }]);
  });

  test('fail sends an error and removes the subscription set', () => {
    const calls = [];
    subscribe('job-3', (data) => calls.push(data));
    fail('job-3', new Error('Upload failed'));

    assert.deepEqual(calls, [{ error: 'Upload failed' }]);
  });

  test('publish and finish are harmless when no subscribers are registered', () => {
    assert.doesNotThrow(() => publish('missing-job', { ok: true }));
    assert.doesNotThrow(() => finish('missing-job', { ok: true }));
    assert.doesNotThrow(() => fail('missing-job', new Error('ignored')));
  });
});

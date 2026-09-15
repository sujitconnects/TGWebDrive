import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanupPath, pruneStaleDirs } from '../src/util.js';

async function makeTempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'tgd-cleanup-test-'));
}

describe('upload temp-file cleanup', () => {
  test('cleanupPath removes a directory tree after a successful upload', async () => {
    const root = await makeTempRoot();
    const upDir = path.join(root, 'tgd-up-success');
    await mkdir(upDir, { recursive: true });
    await writeFile(path.join(upDir, 'file.bin'), 'hello');
    assert.equal(existsSync(upDir), true);

    await cleanupPath(upDir, { label: 'test-cleanup' });

    assert.equal(existsSync(upDir), false);
  });

  test('cleanupPath removes a directory tree after a failed upload too', async () => {
    const root = await makeTempRoot();
    const upDir = path.join(root, 'tgd-up-failed');
    await mkdir(upDir, { recursive: true });
    await writeFile(path.join(upDir, 'partial.bin'), 'partial-data');

    // Simulate the failure path calling cleanup in a catch/finally block.
    let uploadError = null;
    try {
      throw new Error('simulated upload failure');
    } catch (e) {
      uploadError = e;
    } finally {
      await cleanupPath(upDir, { label: 'test-cleanup' });
    }

    assert.equal(uploadError.message, 'simulated upload failure');
    assert.equal(existsSync(upDir), false);
  });

  test('cleanupPath does not throw for a path that does not exist', async () => {
    await assert.doesNotReject(() => cleanupPath('/nonexistent/path/that/does/not/exist'));
  });

  test('cleanupPath is a no-op (does not throw) for empty/undefined input', async () => {
    await assert.doesNotReject(() => cleanupPath(''));
    await assert.doesNotReject(() => cleanupPath(undefined));
    await assert.doesNotReject(() => cleanupPath(null));
  });

  test('pruneStaleDirs removes only directories older than maxAgeMs', async () => {
    const root = await makeTempRoot();
    const staleDir = path.join(root, 'tgd-up-stale');
    const freshDir = path.join(root, 'tgd-up-fresh');
    await mkdir(staleDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });

    const now = Date.now();
    const oldTime = (now - 48 * 3600 * 1000) / 1000; // 48h ago, in seconds for utimes
    await utimes(staleDir, oldTime, oldTime);

    const removed = await pruneStaleDirs(root, 24 * 3600 * 1000, { prefixes: ['tgd-up-'], now });

    assert.equal(removed.includes(staleDir), true);
    assert.equal(existsSync(staleDir), false);
    // An actively-written (recent mtime) directory must never be deleted.
    assert.equal(existsSync(freshDir), true);
  });

  test('pruneStaleDirs only touches directories matching the given prefixes', async () => {
    const root = await makeTempRoot();
    const unrelatedDir = path.join(root, 'some-other-dir');
    await mkdir(unrelatedDir, { recursive: true });
    const now = Date.now();
    const oldTime = (now - 48 * 3600 * 1000) / 1000;
    await utimes(unrelatedDir, oldTime, oldTime);

    const removed = await pruneStaleDirs(root, 24 * 3600 * 1000, { prefixes: ['tgd-up-'], now });

    assert.equal(removed.length, 0);
    assert.equal(existsSync(unrelatedDir), true);
  });

  test('pruneStaleDirs resolves to an empty list for a missing base directory', async () => {
    const removed = await pruneStaleDirs('/nonexistent/base/dir', 1000, { prefixes: ['tgd-up-'] });
    assert.deepEqual(removed, []);
  });
});

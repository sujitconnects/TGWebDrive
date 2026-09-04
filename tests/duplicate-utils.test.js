import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { duplicateKey, findDuplicateItems, hasDuplicateNameSize, normalizeDuplicateName } from '../src/duplicate.js';

describe('duplicate detection utilities', () => {
  test('normalizeDuplicateName trims, lowercases, normalizes spacing and path separators', () => {
    assert.equal(normalizeDuplicateName('  My File.pdf  '), 'my file.pdf');
    assert.equal(normalizeDuplicateName('images\\report.pdf'), 'imagesreport.pdf');
    assert.equal(normalizeDuplicateName('A   B   C.txt'), 'a b c.txt');
    assert.equal(normalizeDuplicateName(''), '');
    assert.equal(normalizeDuplicateName(null), '');
  });

  test('duplicateKey includes the normalized name and size', () => {
    assert.equal(duplicateKey({ name: 'Report.pdf', size: 1200 }), 'report.pdf::1200');
    assert.equal(duplicateKey({ name: 'REPORT.PDF', size: 1200 }), 'report.pdf::1200');
    assert.equal(duplicateKey({ name: 'Report.pdf', size: 0 }), 'report.pdf::0');
  });

  test('findDuplicateItems groups exact duplicates by normalized name and size', () => {
    const files = [
      { name: 'report.pdf', size: 1200 },
      { name: 'Report.pdf', size: 1200 },
      { name: 'notes.txt', size: 900 },
      { name: 'report.pdf', size: 500 },
      { name: 'avatar.png', size: 200 },
      { name: 'AVATAR.PNG', size: 200 },
      { name: 'memo.md', size: 10 },
      { name: 'memo.md', size: 10 }
    ];

    const dupes = findDuplicateItems(files);
    assert.equal(dupes.length, 3);
    assert.deepEqual(
      dupes.map((group) => group.map((it) => it.name).sort()),
      [
        ['Report.pdf', 'report.pdf'],
        ['AVATAR.PNG', 'avatar.png'],
        ['memo.md', 'memo.md'],
      ]
    );
  });

  test('findDuplicateItems ignores undefined names and zero-size entries', () => {
    const files = [
      { name: undefined, size: 0 },
      { name: '', size: 10 },
      { name: 'blank.txt', size: 0 },
      { name: 'alpha.txt', size: 100 },
      { name: 'ALPHA.TXT', size: 100 },
      { name: 'beta.txt', size: 200 },
    ];

    const dupes = findDuplicateItems(files);
    assert.deepEqual(dupes, [[{ name: 'alpha.txt', size: 100 }, { name: 'ALPHA.TXT', size: 100 }]]);
  });

  test('hasDuplicateNameSize returns true for equivalent names and sizes across case and spacing variations', () => {
    const existing = [
      { name: 'invoice.pdf', size: 3000 },
      { name: 'archive.zip', size: 800 },
      { name: 'Invoice.PDF', size: 3000 }
    ];

    assert.equal(hasDuplicateNameSize({ name: 'invoice.pdf', size: 3000 }, existing), true);
    assert.equal(hasDuplicateNameSize({ name: 'INVOICE.PDF', size: 3000 }, existing), true);
    assert.equal(hasDuplicateNameSize({ name: 'invoice.pdf', size: 3500 }, existing), false);
    assert.equal(hasDuplicateNameSize({ name: 'invoice.pdf', size: 3000 }, []), false);
  });

  test('hasDuplicateNameSize rejects null/empty candidate names and ignores empty arrays safely', () => {
    assert.equal(hasDuplicateNameSize(null, [{ name: 'a.txt', size: 10 }]), false);
    assert.equal(hasDuplicateNameSize({}, [{ name: 'a.txt', size: 10 }]), false);
    assert.equal(hasDuplicateNameSize({ name: '', size: 10 }, [{ name: 'a.txt', size: 10 }]), false);
    assert.equal(hasDuplicateNameSize({ name: 'a.txt', size: 10 }, null), false);
    assert.equal(hasDuplicateNameSize({ name: 'a.txt', size: 10 }, []), false);
  });

  test('findDuplicateItems supports caption-based file records as used by the UI', () => {
    const files = [
      { caption: 'Summary 2024.pdf', size: 400 },
      { caption: 'summary 2024.pdf', size: 400 },
      { caption: 'Other file.pdf', size: 300 },
    ];

    const dupes = findDuplicateItems(files);
    assert.equal(dupes.length, 1);
    assert.deepEqual(dupes[0].map((it) => it.caption), ['Summary 2024.pdf', 'summary 2024.pdf']);
  });

  test('findDuplicateItems preserves insertion order while grouping duplicates', () => {
    const files = [
      { name: 'x.txt', size: 10 },
      { name: 'a.txt', size: 20 },
      { name: 'A.TXT', size: 20 },
      { name: 'b.txt', size: 30 },
      { name: 'x.txt', size: 10 },
      { name: 'c.txt', size: 40 },
    ];

    const dupes = findDuplicateItems(files);
    assert.deepEqual(dupes.map((group) => group.map((it) => it.name)), [
      ['x.txt', 'x.txt'],
      ['a.txt', 'A.TXT'],
    ]);
  });

  test('regression: duplicate detection still treats path separators as part of the normalized name and preserves distinct paths', () => {
    const files = [
      { name: 'folder\\nested\\report.pdf', size: 500 },
      { name: 'folder/nested/report.pdf', size: 500 },
      { name: 'report.pdf', size: 500 },
      { name: 'report.pdf', size: 600 },
    ];

    const dupes = findDuplicateItems(files);
    assert.equal(dupes.length, 1);
    assert.deepEqual(
      dupes[0].map((it) => it.name).sort(),
      ['folder/nested/report.pdf', 'folder\\nested\\report.pdf']
    );
  });
});

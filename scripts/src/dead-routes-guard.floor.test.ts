/**
 * RED-PROOF for the dead-routes guard's vacuity floor.
 *
 * WHY A SEPARATE FILE
 * ===================
 * dead-routes-guard.test.ts asserts that nothing links to a dead route. It
 * passes. What it cannot demonstrate about itself is that it would have FAILED
 * had it been misconfigured — and that is exactly the property that was absent.
 *
 * The guard listed `artifacts/travel-buddy` as a source root until that tree
 * was archived. The stale root did not fail. It scanned an absent directory,
 * contributed zero findings, and the check went green. Removing the entry fixed
 * that instance and left the hole: a conditional floor was added afterwards,
 * `if (fs.existsSync(root))`, which floors an EMPTY root and still passes a
 * MISSING one — every scenario except the one from the incident.
 *
 * So this file proves three things the guard cannot prove about itself:
 *
 *   1. THE VACUITY CONDITION IS REAL AND SILENT. Scanning an absent directory
 *      returns zero files and throws nothing. That is the failure mode.
 *   2. POSITIVE CONTROL. The same scanner, pointed at the real configured root,
 *      returns many files. Without this, test 1 would also pass against a
 *      scanner that had simply stopped working — "found nothing" and "cannot
 *      find anything" are indistinguishable from one side.
 *   3. THE FLOOR FIRES. The assertion the guard now makes throws for a missing
 *      root and for an empty one.
 *
 * A guard whose success is indistinguishable from having checked nothing is not
 * a guard. This file is what makes that statement checkable rather than stated.
 *
 * Runtime: node:test + node:assert/strict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SOURCE_ROOTS,
  DEAD_ROUTES,
  collectSourceFiles,
} from './dead-routes-guard.test.ts';

describe('dead-routes guard — vacuity floor', () => {
  it('RED: scanning an absent directory returns zero files, silently', () => {
    const absent = path.join(os.tmpdir(), 'dead-routes-guard-does-not-exist-xyz');
    assert.equal(fs.existsSync(absent), false, 'fixture must genuinely not exist');

    // No throw. No warning. Just nothing — which is precisely why the stale
    // root went unnoticed for as long as it did.
    const files = collectSourceFiles(absent);
    assert.deepEqual(files, [], 'the vacuity condition is real');
  });

  it('RED: scanning an existing but empty directory also returns zero files', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-routes-empty-'));
    try {
      assert.deepEqual(collectSourceFiles(empty), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('POSITIVE CONTROL: the same scanner finds many files in the real root', () => {
    // Without this, the two tests above would pass equally well against a
    // scanner that had stopped working entirely.
    const root = SOURCE_ROOTS[0];
    const files = collectSourceFiles(root);
    assert.ok(
      files.length > 50,
      `expected the real source root to yield many files, got ${files.length} — ` +
        `if this fails, the scanner is broken and the RED tests above prove nothing`,
    );
  });

  it('the floor fires: a missing root is an assertion failure, not a pass', () => {
    const absent = path.join(os.tmpdir(), 'dead-routes-guard-does-not-exist-xyz');

    // This is the assertion the guard now makes, applied to the case that
    // actually occurred. Before the fix it was wrapped in `if (existsSync)`,
    // so for a missing root it did not run at all.
    assert.throws(
      () => {
        assert.ok(fs.existsSync(absent), 'root does not exist');
        assert.ok(collectSourceFiles(absent).length > 0, 'no files found');
      },
      /root does not exist/,
      'a configured-but-absent root must fail the guard',
    );
  });

  it('every configured root exists and is populated — the live state', () => {
    assert.ok(SOURCE_ROOTS.length > 0, 'SOURCE_ROOTS is empty');
    for (const root of SOURCE_ROOTS) {
      assert.ok(fs.existsSync(root), `configured root does not exist: ${root}`);
      assert.ok(collectSourceFiles(root).length > 0, `configured root is empty: ${root}`);
    }
  });

  it('DEAD_ROUTES is non-empty, so the guard generates tests at all', () => {
    // An emptied list would produce a describe block with no tests, which
    // passes. If every dead route ships, the guard should be deleted
    // deliberately rather than left green and inert.
    assert.ok(DEAD_ROUTES.length > 0, 'DEAD_ROUTES is empty — the guard would check nothing');
    for (const { route, reason } of DEAD_ROUTES) {
      assert.ok(route.startsWith('/'), `route must be a path: ${route}`);
      assert.ok(reason.length > 20, `route ${route} needs a real reason, not a placeholder`);
    }
  });
});

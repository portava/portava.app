/**
 * Unit tests for truncateDisplayName — legacy accounts created before the
 * 40-character display-name limit may still have longer names stored in the
 * DB; the passport identity card caps them at render time.
 * Run with:  node --import tsx/esm --test src/utils/identityTruncate.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncateDisplayName, DISPLAY_NAME_MAX_LENGTH } from './identity.ts';

describe('truncateDisplayName', () => {
  it('leaves names at or under 40 chars untouched', () => {
    const exact = 'a'.repeat(40);
    assert.equal(truncateDisplayName(exact), exact);
    assert.equal(truncateDisplayName('Maria Santos'), 'Maria Santos');
    assert.equal(truncateDisplayName(''), '');
  });

  it('truncates a legacy >40-char name to 40 chars plus ellipsis', () => {
    const long = 'x'.repeat(55);
    const out = truncateDisplayName(long);
    assert.equal(out, `${'x'.repeat(40)}…`);
    assert.ok(out.length <= DISPLAY_NAME_MAX_LENGTH + 1);
  });

  it('trims trailing whitespace before adding the ellipsis', () => {
    const name = `${'a'.repeat(39)} bcdef`; // char 40 is a space
    assert.equal(truncateDisplayName(name), `${'a'.repeat(39)}…`);
  });

  it('respects a custom max length', () => {
    assert.equal(truncateDisplayName('abcdefgh', 5), 'abcde…');
  });

  it('exports the shared 30-char limit', () => {
    assert.equal(DISPLAY_NAME_MAX_LENGTH, 30);
  });
});

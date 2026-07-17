/**
 * Regression guard: buddy display names exceeding 30 characters must be
 * visibly truncated in the layover buddies scroll row — not just clipped by
 * numberOfLines.
 *
 * Run:
 *   node --import tsx/esm --test src/components/layover/__tests__/LayoverPeopleSection.truncation.test.ts
 *
 * Because React Native components cannot be mounted in node:test, this guard
 * operates at two levels:
 *
 * 1. Behavioural: primaryIdentityText(b) — the exact expression rendered in
 *    the buddyName <Text> — returns the truncated string (≤30 chars, ending
 *    in "…") for a buddy whose displayName is 40 characters long.
 *
 * 2. Source-level: LayoverPeopleSection.tsx feeds the buddyName <Text> via
 *    primaryIdentityText, not via a raw field access that would bypass
 *    truncation.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { primaryIdentityText } from '../../../lib/displayIdentity.ts';
import { truncateDisplayName, DISPLAY_NAME_MAX_LENGTH } from '../../../utils/identity.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sectionPath = path.resolve(here, '..', 'LayoverPeopleSection.tsx');
const sectionSrc = readFileSync(sectionPath, 'utf8');

// ── 1. Behavioural: truncation logic ─────────────────────────────────────────

const LONG_NAME = 'Bartholomew Alexandros Kingsleigh'; // 34 chars
const FORTY_CHAR_NAME = 'A'.repeat(40);

describe('truncateDisplayName contract', () => {
  test('names within the limit are returned unchanged', () => {
    const name = 'Alice Smith'; // 11 chars
    assert.equal(truncateDisplayName(name), name);
  });

  test('a 40-char name is capped at 30 chars + ellipsis', () => {
    const result = truncateDisplayName(FORTY_CHAR_NAME);
    // The truncated text must not exceed the limit (ellipsis counts as a char)
    assert.ok(
      result.length <= DISPLAY_NAME_MAX_LENGTH + 1,
      `expected truncated length ≤ ${DISPLAY_NAME_MAX_LENGTH + 1}, got ${result.length}`,
    );
    assert.ok(result.endsWith('…'), 'truncated name must end with ellipsis character "…"');
  });

  test('a 34-char name is truncated', () => {
    const result = truncateDisplayName(LONG_NAME);
    assert.ok(
      result.length <= DISPLAY_NAME_MAX_LENGTH + 1,
      `expected truncated length ≤ ${DISPLAY_NAME_MAX_LENGTH + 1}, got ${result.length}`,
    );
    assert.ok(result.endsWith('…'), 'truncated name must end with "…"');
    assert.notEqual(result, LONG_NAME, 'raw long name must not pass through unchanged');
  });

  test('exactly-30-char name is NOT truncated', () => {
    const name30 = 'B'.repeat(30);
    assert.equal(truncateDisplayName(name30), name30);
    assert.ok(!name30.endsWith('…'), 'a 30-char name must not get an ellipsis');
  });
});

// ── 2. primaryIdentityText routes through truncation ─────────────────────────

describe('primaryIdentityText with a long displayName', () => {
  test('rendered text for a 40-char displayName is truncated, not raw', () => {
    const buddy = { displayName: FORTY_CHAR_NAME, handle: 'somehandle' };
    const rendered = primaryIdentityText(buddy);

    assert.notEqual(
      rendered,
      FORTY_CHAR_NAME,
      'primaryIdentityText must not return the raw 40-char name unchanged',
    );
    assert.ok(
      rendered.length <= DISPLAY_NAME_MAX_LENGTH + 1,
      `rendered text must be ≤ ${DISPLAY_NAME_MAX_LENGTH + 1} chars, got ${rendered.length}: "${rendered}"`,
    );
    assert.ok(
      rendered.endsWith('…'),
      `rendered text must end with "…" for a long name; got: "${rendered}"`,
    );
  });

  test('rendered text for a 34-char name differs from the raw name', () => {
    const buddy = { displayName: LONG_NAME, handle: 'barts' };
    const rendered = primaryIdentityText(buddy);

    assert.notEqual(rendered, LONG_NAME, 'raw 34-char name must not appear in the rendered output');
    assert.ok(rendered.endsWith('…'), `expected ellipsis suffix; got: "${rendered}"`);
  });

  test('short names (≤30 chars) pass through unchanged', () => {
    const buddy = { displayName: 'Maria Santos', handle: 'maria' };
    const rendered = primaryIdentityText(buddy);
    assert.equal(rendered, 'Maria Santos');
    assert.ok(!rendered.endsWith('…'));
  });

  test('handle fallback is used when displayName is null', () => {
    const buddy = { displayName: null, handle: 'travelerbob' };
    const rendered = primaryIdentityText(buddy);
    assert.equal(rendered, '@travelerbob');
  });
});

// ── 3. Source-level: LayoverPeopleSection routes buddyName through primaryIdentityText ──

describe('LayoverPeopleSection source wires buddyName via primaryIdentityText', () => {
  test('primaryIdentityText is imported', () => {
    assert.match(
      sectionSrc,
      /import\s*\{[^}]*primaryIdentityText[^}]*\}\s*from/,
      'LayoverPeopleSection.tsx must import primaryIdentityText',
    );
  });

  test('buddyName <Text> is fed by primaryIdentityText(b), not a raw field', () => {
    // The render call: primaryIdentityText(b) inside the buddyName Text element
    assert.match(
      sectionSrc,
      /buddyName[^>]*>[\s\S]*?primaryIdentityText\s*\(\s*b\s*\)/,
      'buddyName Text must render primaryIdentityText(b) — raw b.displayName bypasses truncation',
    );
  });

  test('buddyName Text element does not directly embed b.displayName', () => {
    // The buddyName <Text> must call primaryIdentityText(b), not read b.displayName inline.
    // (b.displayName is legitimately used in initials() for photo fallback — that is fine.)
    // Extract just the buddyName Text tag content to avoid matching the initials call above it.
    const buddyNameTextMatch = sectionSrc.match(
      /style={styles\.buddyName}[^>]*numberOfLines[^>]*>\s*\{([^}]+)\}/,
    );
    assert.ok(
      buddyNameTextMatch !== null,
      'Could not locate the buddyName <Text> element in LayoverPeopleSection.tsx — check the selector',
    );
    const textContent = buddyNameTextMatch![1]!;
    assert.ok(
      !textContent.includes('b.displayName'),
      `buddyName Text content ("${textContent}") must not reference b.displayName — use primaryIdentityText(b)`,
    );
    assert.ok(
      textContent.includes('primaryIdentityText'),
      `buddyName Text content ("${textContent}") must call primaryIdentityText`,
    );
  });
});

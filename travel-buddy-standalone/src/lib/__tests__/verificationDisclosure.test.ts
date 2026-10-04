/**
 * verificationDisclosure — what the ID-check screen promises, held to the schema
 * it describes (census-trust §31: TV-2b and TV-2d).
 *
 * TV-2b: the plan's intro is "what / why / **what we never store**", and the
 * screen had no privacy disclosure at all. A disclosure is a promise, so the
 * test below does not just check that sentences exist: it reads the server's
 * own `identity_verifications` schema and the normalized result type and
 * fails if a "never stored" item gains a column, or a "kept" item loses one.
 *
 * TV-2d: a failure showed the raw enum with underscores swapped for spaces
 * ("document invalid", "underage"), and EVERY failure re-offered the GET
 * VERIFIED buttons — including `underage`, the one the plan says must route to
 * an age-policy screen and not allow retry spam.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/verificationDisclosure.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERIFICATION_NEVER_STORED,
  VERIFICATION_KEPT,
  verificationFailureCopy,
  verificationRetryAllowed,
  AGE_POLICY_ROUTE,
  type DisclosedFailureReason,
} from '../verificationDisclosure.ts';

// From src/lib/__tests__/ back to the repository root (the string-path form:
// this tsconfig's DOM lib makes `new URL()` a type node:fs does not accept).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

/** The columns of identity_verifications as the schema of record declares them. */
function identityVerificationColumns(): string[] {
  const sql = read('db/migrations/0161_identity_verification.sql');
  const start = sql.indexOf('create table if not exists identity_verifications');
  assert.notEqual(start, -1, 'the identity_verifications DDL moved — re-point this test, do not delete it');
  const body = sql.slice(start, sql.indexOf(');', start));
  return [...body.matchAll(/^\s+([a-z_0-9]+)\s+(?:uuid|text|boolean|timestamptz)\b/gm)].map((m) => m[1]!);
}

const ALL_REASONS: DisclosedFailureReason[] = [
  'document_invalid', 'selfie_mismatch', 'underage', 'abandoned', 'provider_error', 'other',
];

describe('TV-2b — "what we never store" is true of the schema it describes', () => {
  it('names the four things the plan promises are never kept', () => {
    const text = VERIFICATION_NEVER_STORED.map((i) => i.label.toLowerCase()).join(' | ');
    for (const word of ['image', 'number', 'selfie', 'date of birth']) {
      assert.ok(text.includes(word), `the never-stored list must cover "${word}": ${text}`);
    }
  });

  it('no column of identity_verifications can hold a never-stored item', () => {
    const cols = identityVerificationColumns();
    assert.ok(cols.length >= 10, `parsed too few columns to mean anything: ${cols.join(',')}`);
    for (const item of VERIFICATION_NEVER_STORED) {
      for (const col of cols) {
        assert.ok(
          !item.forbiddenColumn.test(col),
          `"${item.label}" is promised never stored, but identity_verifications has a column "${col}"`,
        );
      }
    }
  });

  it('every "kept" item names a column that really exists — the disclosure cannot drift from the table', () => {
    const cols = new Set(identityVerificationColumns());
    for (const item of VERIFICATION_KEPT) {
      for (const col of item.columns) {
        assert.ok(cols.has(col), `"${item.label}" cites column "${col}", which identity_verifications does not have`);
      }
    }
  });

  it('the normalized result the server consumes declares no never-stored field either', () => {
    const types = read('artifacts/api-server/src/services/identityVerification/types.ts');
    const start = types.indexOf('export interface VerificationResult {');
    const body = types.slice(start, types.indexOf('}', start));
    const fields = [...body.matchAll(/^\s+([A-Za-z0-9]+)\??:/gm)].map((m) => m[1]!);
    assert.ok(fields.includes('isOver18'), `parsed the wrong interface: ${fields.join(',')}`);
    for (const item of VERIFICATION_NEVER_STORED) {
      for (const f of fields) {
        const snake = f.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`);
        assert.ok(!item.forbiddenColumn.test(snake), `VerificationResult.${f} would carry "${item.label}"`);
      }
    }
  });
});

describe('TV-2d — a failure says what happened, and underage does not invite a retry', () => {
  it('every normalized reason has human copy — never the enum, never underscores', () => {
    for (const reason of ALL_REASONS) {
      const copy = verificationFailureCopy(reason);
      assert.ok(copy.length > 20, `${reason}: copy too thin`);
      assert.ok(!copy.includes('_'), `${reason}: "${copy}" still shows a machine string`);
      assert.ok(!copy.toLowerCase().includes(reason.replace(/_/g, ' ')) || reason === 'other',
        `${reason}: copy must not be the enum with spaces: "${copy}"`);
    }
  });

  it('the plan\'s two named cases read as the plan words them', () => {
    assert.match(verificationFailureCopy('document_invalid'), /couldn't read your document/i);
    assert.match(verificationFailureCopy('selfie_mismatch'), /selfie didn't match/i);
  });

  it('an unknown or missing reason still gets human copy', () => {
    assert.ok(!verificationFailureCopy(null).includes('_'));
    assert.ok(!verificationFailureCopy('some_new_reason' as DisclosedFailureReason).includes('_'));
  });

  it('underage is the ONE failure that does not re-offer the check', () => {
    assert.equal(verificationRetryAllowed({ status: 'failed', failureReason: 'underage' }), false);
    for (const reason of ALL_REASONS.filter((r) => r !== 'underage')) {
      assert.equal(verificationRetryAllowed({ status: 'failed', failureReason: reason }), true, reason);
    }
    assert.equal(verificationRetryAllowed({ status: 'expired', failureReason: null }), true);
    assert.equal(verificationRetryAllowed(null), true, 'no attempt yet: the first check is always offered');
  });

  it('underage copy states the age requirement without disclosing the document or the birthday', () => {
    const copy = verificationFailureCopy('underage').toLowerCase();
    assert.match(copy, /18/);
    assert.ok(!/birth|born|document says|your age is/.test(copy), `must not disclose what the document said: ${copy}`);
  });

  it('the age-policy route is a real app route', () => {
    const routes = read('travel-buddy-standalone/src/navigation/portavaRoutes.ts');
    assert.ok(routes.includes(`path: '${AGE_POLICY_ROUTE.replace(/^\//, '')}'`),
      `${AGE_POLICY_ROUTE} is not registered in PORTAVA_ROUTES — a link to it is a dead end`);
  });
});

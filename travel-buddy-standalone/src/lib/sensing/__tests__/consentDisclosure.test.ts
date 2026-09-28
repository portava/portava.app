/**
 * consentDisclosure — what a recorded consent VERSION permits on the device,
 * and that the words for each version cannot drift from the evidence.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *   1. The v1 words are the words people already agreed to. Editing them
 *      without a new version would make every existing record name text its
 *      holder never saw — so they are pinned by hash here.
 *   2. v1 does NOT permit the passive capture loop, and does not permit
 *      surface. Only a version whose words describe passive sensing does.
 *   3. The device and the server agree on the version strings and on what each
 *      one covers (the server's table: artifacts/api-server/src/lib/
 *      sensingConsentScopes.ts), so the device never starts a loop the server's
 *      session issuer would refuse, and the reverse.
 *   4. The capture installer consults (2), not bare "consent is on".
 *
 * WATCHED IT FAIL: with v1's `coversPassiveSensing` set true, "v1 does not
 * start the passive loop" and "device and server agree" go red; with the
 * installer switched back to `hasValidConsent`, "the installer asks whether the
 * recorded version covers passive sensing" goes red; editing one character of
 * a v1 paragraph turns "the v1 words are pinned" red.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONSENT_DISCLOSURES,
  CONSENT_V1,
  CONSENT_V2,
  consentCoversPassiveSensing,
  disclosureFor,
  needsReconsent,
} from '../consentDisclosure.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', '..', '..', '..');
const REPO = join(CLIENT, '..');

const on = (consentVersion: string | null, current: string | null = CONSENT_V1) => ({
  enabled: true,
  consentVersion,
  withdrawnAt: null,
  currentDisclosureVersion: current,
});

describe('consentDisclosure — the words are the evidence', () => {
  test('the v1 words are pinned: changing them needs a new version, not an edit', () => {
    const v1 = CONSENT_DISCLOSURES[CONSENT_V1]!;
    const digest = createHash('sha256')
      .update(JSON.stringify([v1.title, ...v1.paragraphs, v1.footnote]))
      .digest('hex');
    assert.equal(digest, V1_WORDS_SHA256);
  });

  test('an unknown or absent version has no words — never the previous text', () => {
    assert.equal(disclosureFor(null), null);
    assert.equal(disclosureFor(''), null);
    assert.equal(disclosureFor('intel_contributions_v0'), null);
    assert.equal(disclosureFor(CONSENT_V1)?.version, CONSENT_V1);
    assert.equal(disclosureFor(CONSENT_V2)?.version, CONSENT_V2);
  });

  test('v2 says what surface discloses, and that it is never a count or a person', () => {
    const text = CONSENT_DISCLOSURES[CONSENT_V2]!.paragraphs.join(' ');
    assert.match(text, /in the background/);
    assert.match(text, /other travelers may see that people are around/);
    assert.match(text, /Never how many, and never who/);
    assert.match(text, /No exact location/);
  });
});

describe('consentDisclosure — what a recorded version permits', () => {
  test('v1 does not start the passive loop and does not permit surface', () => {
    assert.equal(consentCoversPassiveSensing(on(CONSENT_V1)), false);
    assert.equal(CONSENT_DISCLOSURES[CONSENT_V1]!.coversSurface, false);
  });

  test('v2 starts it — but only while enabled and not withdrawn', () => {
    assert.equal(consentCoversPassiveSensing(on(CONSENT_V2, CONSENT_V2)), true);
    assert.equal(consentCoversPassiveSensing({ ...on(CONSENT_V2), enabled: false }), false);
    assert.equal(consentCoversPassiveSensing({ ...on(CONSENT_V2), withdrawnAt: '2026-09-26T00:00:00Z' }), false);
    assert.equal(consentCoversPassiveSensing(null), false);
    assert.equal(consentCoversPassiveSensing(on('some_unclassified_version')), false);
  });

  test('re-consent is flagged when the recorded version is not the one the server now stamps', () => {
    assert.equal(needsReconsent(on(CONSENT_V1, CONSENT_V1)), false);
    assert.equal(needsReconsent(on(CONSENT_V1, CONSENT_V2)), true);
    assert.equal(needsReconsent({ ...on(CONSENT_V1, CONSENT_V2), enabled: false }), false, 'no consent, nothing to renew');
  });
});

describe('consentDisclosure — device and server agree', () => {
  const server = readFileSync(join(REPO, 'artifacts/api-server/src/lib/sensingConsentScopes.ts'), 'utf8');
  const stamp = readFileSync(join(REPO, 'artifacts/api-server/src/lib/intelConsent.ts'), 'utf8');

  test('the version strings are the server’s strings', () => {
    assert.match(server, new RegExp(`SENSING_CONSENT_V1 = "${CONSENT_V1}"`));
    assert.match(server, new RegExp(`SENSING_CONSENT_V2 = "${CONSENT_V2}"`));
    assert.match(stamp, new RegExp(`LEGACY_CLIENT_DISCLOSURE_VERSION = "${CONSENT_V1}"`), 'a bare grant is evidence of these v1 words');
  });

  test('what each version covers is what the server issues sessions for', () => {
    const row = (k: string) => {
      const m = server.match(new RegExp(`\\[${k}\\]: Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
      assert.ok(m, `${k} row found in the server table`);
      return m![1]!.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
    };
    for (const [key, version] of [['SENSING_CONSENT_V1', CONSENT_V1], ['SENSING_CONSENT_V2', CONSENT_V2]] as const) {
      const scopes = row(key);
      const d = CONSENT_DISCLOSURES[version]!;
      assert.equal(scopes.includes('collect'), d.coversPassiveSensing, `${version}: collect ⇔ passive loop`);
      assert.equal(scopes.includes('surface'), d.coversSurface, `${version}: surface agrees`);
    }
  });

  test('the server still stamps v1: v2 is defined, not in force', () => {
    assert.match(stamp, new RegExp(`INTEL_CONSENT_DISCLOSURE_VERSION = "${CONSENT_V1}"`));
  });

  test('the installer asks whether the recorded version covers passive sensing, not merely whether consent is on', () => {
    const src = readFileSync(join(CLIENT, 'src/services/sensing/installSensingCapture.ts'), 'utf8');
    assert.equal((src.match(/consentCoversPassiveSensing\(await getIntelConsent\(\)\)/g) ?? []).length, 2);
    assert.doesNotMatch(src, /hasValidConsent/);
  });
});

/** sha256 of JSON [title, ...paragraphs, footnote] for v1 — the text shipped before versions were keyed. */
const V1_WORDS_SHA256 = '32ad2536a4a6e3f1c94cb4812ff81bde29e7f44b2cf704a8b9351aba74a696f5';

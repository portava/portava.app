/**
 * OD-MAP-6's three passive-sensing consents, device side (lib/sensing/consentSplit).
 *
 *   · the versions are the SERVER's (artifacts/api-server/src/lib/sensingConsentGrants.ts),
 *     read from its source so the two cannot drift;
 *   · each consent's words name what is captured, where it goes, who sees it and
 *     how to turn it off (lead ruling on Q-L20), and the later two say they need
 *     the earlier ones;
 *   · words are shown only for the version the server has in force;
 *   · the capture loop's decision: nothing without capture; nothing SENT without
 *     upload; an unreadable consent allows nothing.
 *
 * Run: node --import tsx/esm --test src/lib/sensing/__tests__/consentSplit.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SENSING_CONSENT_SCOPES,
  SENSING_CONSENT_WORDS,
  sensingCaptureDecision,
  wordsFor,
} from '../consentSplit.ts';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = readFileSync(join(CLIENT, '../artifacts/api-server/src/lib/sensingConsentGrants.ts'), 'utf8');

const ok = (capture: boolean, upload: boolean, surface = false) => ({
  status: 'ok' as const,
  state: { consents: { capture: { effective: capture }, upload: { effective: upload }, surface: { effective: surface } } },
});

describe('OD-MAP-6 — the three consents on the device', () => {
  test('the versions are the server’s, scope by scope', () => {
    for (const s of SENSING_CONSENT_SCOPES) {
      assert.match(server, new RegExp(`${s}: "${SENSING_CONSENT_WORDS[s].version}"`), `${s} version differs from the server's`);
    }
  });

  test('every consent says what, where, who and how to turn it off — in words, not left blank', () => {
    for (const s of SENSING_CONSENT_SCOPES) {
      const w = SENSING_CONSENT_WORDS[s];
      for (const k of ['title', 'what', 'where', 'who', 'off'] as const) assert.ok(w[k].trim().length > 20, `${s}.${k} is missing or too thin`);
      assert.match(w.off, /turn this off at any time/i, `${s} must say it can be turned off`);
    }
    assert.match(SENSING_CONSENT_WORDS.capture.where, /stays on this phone/i);
    assert.match(SENSING_CONSENT_WORDS.upload.who, /no one sees your signals on their own/i);
    assert.match(SENSING_CONSENT_WORDS.surface.where, /does not show these results to anyone yet/i, 'surface must not imply it is live');
    assert.ok(SENSING_CONSENT_WORDS.upload.needs && SENSING_CONSENT_WORDS.surface.needs, 'later consents say they need the earlier ones');
  });

  test('words are shown only for the version the server has in force', () => {
    assert.equal(wordsFor('upload', 'sensing_upload_v1')?.version, 'sensing_upload_v1');
    assert.equal(wordsFor('upload', 'sensing_upload_v2'), null);
    assert.equal(wordsFor('capture', null), null);
  });

  test('the capture loop: nothing without capture; nothing sent without upload; unreadable allows nothing', () => {
    assert.deepEqual(sensingCaptureDecision(ok(false, false)), { capture: false, upload: false });
    assert.deepEqual(sensingCaptureDecision(ok(true, false)), { capture: true, upload: false });
    assert.deepEqual(sensingCaptureDecision(ok(false, true)), { capture: false, upload: false }, 'upload never outruns capture');
    assert.deepEqual(sensingCaptureDecision(ok(true, true, true)), { capture: true, upload: true });
    assert.deepEqual(sensingCaptureDecision({ status: 'unreadable' }), { capture: false, upload: false });
    assert.deepEqual(sensingCaptureDecision(null), { capture: false, upload: false });
  });

  test('the installer drops every send unless upload is in effect, and re-checks on every Settings change', () => {
    const src = readFileSync(join(CLIENT, 'src/services/sensing/installSensingCapture.ts'), 'utf8');
    assert.match(src, /if \(!uploadAllowed\) return;\s*await transport\.submit\(payload\);/);
    assert.match(src, /onSensingConsentChange\(/);
  });
});

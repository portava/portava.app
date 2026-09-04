/**
 * contributionFlow tests — §22's eighth prompt as the two calls §21 requires.
 *
 * These are written against the RULES, not the implementation shape:
 *
 *   §21  Observation -> Evidence. The observation is submitted FIRST and the
 *        evidence carries its id; evidence can never go first, and never alone.
 *   §22  media is EVIDENCE, not a claim. It mints no claim type and carries no
 *        coordinate — the whole reason the upload path strips EXIF/GPS.
 *   §22  a half-landed act is stated, not hidden: an observation that was
 *        recorded with a photo that was not is a real outcome and must read as
 *        one.
 *   ---  a retry of the photo NEVER re-runs the observation. One act must not
 *        become two reports.
 *
 * The transport is faked so every assertion can be made on an ORDERED CALL LOG
 * rather than on "both things happened".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { MapGeometry, MapObject } from '../../../../types/mapObjects.ts';
import { createContribution, type MapContribution } from '../liveTruth.ts';
import {
  answerSummary,
  attachMediaEvidence,
  beginMedia,
  beginObservation,
  settleMedia,
  settleObservation,
  submitObservation,
  type ContributionSubmitResult,
  type ContributionTransport,
  type MapMediaAsset,
  type MediaUploadOutcome,
} from '../contributionFlow.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-31T22:00:00.000Z');
const OBSERVATION_ID = 'a3f7f6f2-0f2a-4a2b-9f4a-6d3f9c1b2e10';
/** What POST /api/media/upload actually returns: a bare storage reference. */
const STORAGE_REF = 'post-media/user-1/1785413296467.jpg';
/** What the device hands the picker. This must never reach the ingest. */
const DEVICE_URI = 'file:///var/mobile/tmp/IMG_0042.HEIC';

const POINT: MapGeometry = { type: 'Point', coordinates: [108.22, 16.06] };

function obj(over: Partial<MapObject> = {}): MapObject {
  return {
    id: 'place-1',
    kind: 'place',
    geometry: POINT,
    title: 'Bamboo 2',
    privacyClass: 'place_level',
    renderingPriority: 40,
    ...over,
  };
}

const ASSET: MapMediaAsset = { uri: DEVICE_URI, mimeType: 'image/jpeg', type: 'image' };

function crowdAnswer(): MapContribution {
  const c = createContribution(obj(), 'crowd_level', 'busy', { now: NOW });
  assert.ok(c, 'fixture: the crowd_level answer must be constructible');
  return c;
}

// ── The fake transport ─────────────────────────────────────────────────────────

interface Recorder {
  /** Every call, in the order it was MADE. */
  log: string[];
  /** Every contribution posted, in order. */
  posted: MapContribution[];
  transport: ContributionTransport;
}

interface FakeOpts {
  submit?: (c: MapContribution, n: number) => ContributionSubmitResult;
  upload?: (asset: MapMediaAsset) => MediaUploadOutcome;
}

const accepted = (over: Record<string, unknown> = {}): ContributionSubmitResult => ({
  ok: true,
  enabled: true,
  accepted: 1,
  observationId: OBSERVATION_ID,
  evidenceId: 'ev-1',
  deduped: false,
  ...over,
});

function fake(opts: FakeOpts = {}): Recorder {
  const log: string[] = [];
  const posted: MapContribution[] = [];
  let n = 0;
  return {
    log,
    posted,
    transport: {
      submit: async (c) => {
        // Logged BEFORE the await resolves, so the log is the call order.
        log.push(`submit:${c.kind}`);
        posted.push(c);
        n += 1;
        return opts.submit ? opts.submit(c, n) : accepted();
      },
      upload: async (asset) => {
        log.push('upload');
        return opts.upload ? opts.upload(asset) : { ok: true, url: STORAGE_REF };
      },
    },
  };
}

/** The whole act, in the order the sheet performs it. */
async function runWholeAct(r: Recorder) {
  const step1 = await submitObservation(crowdAnswer(), r.transport);
  assert.ok(step1.ok, 'fixture: step 1 was expected to land');
  return attachMediaEvidence(
    { object: obj(), observationId: step1.observationId, mediaKind: 'photo', asset: ASSET, now: NOW },
    r.transport,
  );
}

// ── §21 · the order ────────────────────────────────────────────────────────────

describe('§21 — Observation then Evidence, in that order', () => {
  test('the two contribution calls are made in order, with the upload between them', async () => {
    const r = fake();
    const outcome = await runWholeAct(r);

    assert.ok(outcome.ok);
    // The ORDER, not merely the membership. Reversing any two of these is the
    // defect this test exists to catch: evidence before its observation is
    // refused by a NOT NULL column, and a media payload built before the
    // upload would carry a device URI the server cannot accept.
    assert.deepEqual(r.log, ['submit:crowd_level', 'upload', 'submit:media']);
  });

  test('the media call carries the observation id the observation returned', async () => {
    const r = fake({
      submit: (c, n) =>
        // Step 1 answers with an id nobody could have guessed; step 2 must
        // carry THAT one, not a constant and not the object's id.
        n === 1 ? accepted({ observationId: 'obs-from-the-server-9', evidenceId: null }) : accepted(),
    });
    await runWholeAct(r);

    const media = r.posted[1];
    assert.equal(media.kind, 'media');
    assert.equal((media as { observationId: string }).observationId, 'obs-from-the-server-9');
  });

  test('evidence never goes first: with no observation nothing is uploaded or sent', async () => {
    for (const observationId of [null, undefined, '', '   ']) {
      const r = fake();
      const outcome = await attachMediaEvidence(
        { object: obj(), observationId, mediaKind: 'photo', asset: ASSET, now: NOW },
        r.transport,
      );
      assert.equal(outcome.ok, false);
      assert.equal(outcome.ok === false && outcome.reason, 'not_constructible');
      // The refusal happens BEFORE the asset is touched: a bare photo is not a
      // §22 contribution however good the file is, so uploading first would
      // spend the contributor's bandwidth on something that cannot be stored.
      assert.deepEqual(r.log, [], 'nothing may be sent for a photo with no observation');
    }
  });

  test('the media payload carries the uploaded reference, never the device URI', async () => {
    const r = fake();
    await runWholeAct(r);

    const media = r.posted[1] as { mediaUri: string };
    assert.equal(media.mediaUri, STORAGE_REF);
    assert.notEqual(media.mediaUri, DEVICE_URI);
  });
});

// ── §22 · what the media path may not carry ────────────────────────────────────

describe('§22 — a photo is evidence, so it carries nothing a claim would', () => {
  test('no coordinate, no claim type, no reward reaches the media payload', async () => {
    const r = fake();
    await runWholeAct(r);

    const media = r.posted[1];
    assert.ok(media, 'the media contribution must have been posted');
    assert.deepEqual(
      Object.keys(media).sort(),
      ['kind', 'mediaUri', 'objectId', 'objectKind', 'observationId', 'observedAt', 'value'],
    );
    for (const forbidden of [
      'lat', 'lng', 'latitude', 'longitude', 'coordinates', 'geometry', 'location', 'exif',
      'claimType', 'claim', 'confidence', 'reward', 'paid', 'sponsored',
    ]) {
      assert.ok(!(forbidden in media), `the media payload must not carry "${forbidden}"`);
    }
    // `value` is the ASSET TYPE, not a proposition about the world.
    assert.equal(media.value, 'photo');
  });

  test('the upload is handed the asset and the asset only', async () => {
    const seen: MapMediaAsset[] = [];
    const r = fake({
      upload: (asset) => {
        seen.push(asset);
        return { ok: true, url: STORAGE_REF };
      },
    });
    await runWholeAct(r);

    assert.equal(seen.length, 1);
    const asset = seen[0];
    assert.ok(asset, 'the upload seam must have been handed an asset');
    for (const forbidden of ['lat', 'lng', 'latitude', 'longitude', 'coords', 'location']) {
      assert.ok(!(forbidden in asset));
    }
  });
});

// ── The failure the contributor must be told about ─────────────────────────────

describe('a half-landed act is stated, never hidden', () => {
  test('a failed upload does not retry into a second observation', async () => {
    const r = fake({ upload: () => ({ ok: false, url: null, message: 'Upload failed (HTTP 500)' }) });

    const step1 = await submitObservation(crowdAnswer(), r.transport);
    assert.ok(step1.ok);
    const first = await attachMediaEvidence(
      { object: obj(), observationId: step1.observationId, mediaKind: 'photo', asset: ASSET, now: NOW },
      r.transport,
    );
    assert.equal(first.ok, false);
    assert.equal(first.ok === false && first.reason, 'upload_failed');

    // The retry: the SAME observation id, and no path back into step 1.
    const again = await attachMediaEvidence(
      { object: obj(), observationId: step1.observationId, mediaKind: 'photo', asset: ASSET, now: NOW },
      r.transport,
    );
    assert.equal(again.ok, false);

    assert.deepEqual(r.log, ['submit:crowd_level', 'upload', 'upload']);
    assert.equal(
      r.log.filter((l) => l === 'submit:crowd_level').length,
      1,
      'one act must never become two reports',
    );
  });

  test('the failure sentence says the report landed and the photo did not', () => {
    const state = settleObservation(
      beginObservation('crowd_level', 'busy'),
      { ok: true, observationId: OBSERVATION_ID, deduped: false },
    );
    const failed = settleMedia(
      beginMedia(state, 'photo'),
      { ok: false, reason: 'upload_failed', detail: 'Upload failed (HTTP 500)' },
      'photo',
    );

    assert.equal(failed.phase, 'attach_failed');
    assert.match(failed.status, /report was recorded/i);
    assert.match(failed.status, /photo could not be uploaded/i);
    assert.equal(failed.detail, 'Upload failed (HTTP 500)');
    // The observation survives the failure — that is what makes the retry safe.
    assert.equal(failed.observationId, OBSERVATION_ID);
    assert.equal(failed.retry, 'media', 'only the photo may be retried');
    assert.notEqual(failed.retry, 'observation');
  });

  test('backing out of the picker is not a failure and sends nothing', async () => {
    const r = fake();
    const outcome = await attachMediaEvidence(
      { object: obj(), observationId: OBSERVATION_ID, mediaKind: 'photo', asset: null, now: NOW },
      r.transport,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'cancelled');
    assert.deepEqual(r.log, []);

    const observed = settleObservation(
      beginObservation('crowd_level', 'busy'),
      { ok: true, observationId: OBSERVATION_ID, deduped: false },
    );
    const back = settleMedia(observed, outcome, 'photo');
    assert.equal(back.phase, 'observed');
    assert.equal(back.retry, null);
  });
});

// ── A refusal is a refusal ─────────────────────────────────────────────────────

describe('the server saying no is rendered as no', () => {
  test('a refused media contribution is a failure, not an attachment', async () => {
    const r = fake({
      submit: (c, n) =>
        n === 1
          ? accepted()
          : {
              ok: false,
              // The server's own words for a bare/foreign artifact.
              error: 'a photo is evidence, not a claim',
              errorCode: 'invalid_payload',
            },
    });
    const outcome = await runWholeAct(r);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'refused');
    const state = settleMedia(
      beginMedia(
        settleObservation(beginObservation('crowd_level', 'busy'), {
          ok: true,
          observationId: OBSERVATION_ID,
          deduped: false,
        }),
        'photo',
      ),
      outcome,
      'photo',
    );
    assert.equal(state.phase, 'attach_failed');
    assert.notEqual(state.phase, 'attached');
    assert.match(state.status, /was not recorded/i);
    assert.equal(state.detail, 'a photo is evidence, not a claim');
  });

  test('a refused observation never yields an id to hang a photo off', async () => {
    const r = fake({
      submit: () => ({ ok: false, error: 'Consent required', errorCode: 'forbidden' }),
    });
    const outcome = await submitObservation(crowdAnswer(), r.transport);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'refused');
    const state = settleObservation(beginObservation('crowd_level', 'busy'), outcome);
    assert.equal(state.phase, 'observation_failed');
    assert.equal(state.observationId, null, 'no id means the media step cannot be offered');
    assert.equal(state.retry, 'observation');
  });

  test('the flag-off envelope is not a success', async () => {
    // The server fail-softs a disabled capture surface as `ok: true` with
    // `accepted: 0`. Reading that as "recorded" would tell a contributor their
    // report landed when nothing was written.
    const r = fake({ submit: () => ({ ok: true, enabled: false, accepted: 0 }) });
    const outcome = await submitObservation(crowdAnswer(), r.transport);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'not_enabled');
    const state = settleObservation(beginObservation('crowd_level', 'busy'), outcome);
    assert.equal(state.phase, 'observation_failed');
    assert.match(state.status, /not switched on/i);
    assert.equal(state.retry, null, 'retrying a switched-off capability is not a fix');
  });

  test('an accepted observation with no id is refused rather than half-believed', async () => {
    const r = fake({ submit: () => accepted({ observationId: null }) });
    const outcome = await submitObservation(crowdAnswer(), r.transport);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'refused');
  });

  test('a network failure reads as unsent, not as refused', async () => {
    const r = fake({ submit: () => ({ ok: false, error: 'Network error', errorCode: null }) });
    const outcome = await submitObservation(crowdAnswer(), r.transport);
    assert.equal(outcome.ok === false && outcome.reason, 'transport_failed');
    const state = settleObservation(beginObservation('crowd_level', 'busy'), outcome);
    assert.match(state.status, /could not be sent/i);
  });
});

// ── What the contributor reads ─────────────────────────────────────────────────

describe('the words the sheet shows', () => {
  test('the answer is echoed as the prompt and the option, in §22 vocabulary', () => {
    assert.equal(answerSummary('crowd_level', 'busy'), 'How busy is it? · Busy');
    assert.equal(answerSummary('closure', 'temporarily_closed'), 'Is it open? · Temporarily closed');
  });

  test('nothing is claimed while the request is still in flight', () => {
    const s = beginObservation('vibe', 'going_off');
    assert.equal(s.phase, 'submitting');
    assert.equal(s.busy, true);
    assert.equal(s.observationId, null);
    assert.match(s.status, /Recording/);
    assert.doesNotMatch(s.status, /recorded\./i);
  });

  test('a deduped replay says so rather than claiming a fresh write', () => {
    const s = settleObservation(beginObservation('crowd_level', 'busy'), {
      ok: true,
      observationId: OBSERVATION_ID,
      deduped: true,
    });
    assert.equal(s.phase, 'observed');
    assert.equal(s.status, 'Already recorded.');
  });

  test('a successful attach names the artifact and never a map change', () => {
    const observed = settleObservation(beginObservation('crowd_level', 'busy'), {
      ok: true,
      observationId: OBSERVATION_ID,
      deduped: false,
    });
    const s = settleMedia(beginMedia(observed, 'photo'), { ok: true, evidenceId: 'ev-1', deduped: false }, 'photo');
    assert.equal(s.phase, 'attached');
    assert.equal(s.status, 'Photo attached to your report.');
    // §22/§37: the sheet may never imply the contribution moved the map or the
    // confidence in it.
    for (const forbidden of [/confiden/i, /verified/i, /the map now/i, /reward/i]) {
      assert.doesNotMatch(s.status, forbidden);
    }
  });
});

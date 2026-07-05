/**
 * Unit tests for CircleStatusCardMessage pure logic helpers.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/CircleStatusCardMessage.test.ts
 *
 * ## Why this file exists
 *
 * `CircleStatusCardMessage` renders a circle_status_card system message in a
 * Telegraph thread.  Its body arrives as a raw JSON string — null, empty, or
 * malformed input must never produce a blank/crashed card.  These tests lock
 * in the correct rendering decision for every edge-case input so a regression
 * is caught at CI time, not at runtime on a user's device.
 *
 * The component itself imports React Native (not testable in node:test), so we
 * extract the pure decision logic into CircleStatusCardMessage.logic.ts and
 * test that directly — same machine-layer pattern used by EventsDiscovery and
 * ReportPostSheet tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCircleCardBody,
  classifySubtype,
  checkinLabel,
  resolveCardRender,
} from '../CircleStatusCardMessage.logic.ts';

// ── parseCircleCardBody ───────────────────────────────────────────────────────

describe('parseCircleCardBody — body parsing', () => {
  it('parses a valid check-in JSON body', () => {
    const result = parseCircleCardBody('{"subtype":"arrived"}');
    assert.deepEqual(result, { subtype: 'arrived' });
  });

  it('parses a valid meeting_point body with venue label', () => {
    const result = parseCircleCardBody(
      '{"subtype":"meeting_point","venueLabel":"Cafe Luna","approxArea":"BGC"}',
    );
    assert.deepEqual(result, {
      subtype: 'meeting_point',
      venueLabel: 'Cafe Luna',
      approxArea: 'BGC',
    });
  });

  it('returns null for a null body', () => {
    assert.equal(parseCircleCardBody(null), null);
  });

  it('returns null for an undefined body', () => {
    assert.equal(parseCircleCardBody(undefined), null);
  });

  it('returns null for an empty string body', () => {
    assert.equal(parseCircleCardBody(''), null);
  });

  it('returns null for malformed JSON', () => {
    assert.equal(parseCircleCardBody('{broken json{{'), null);
  });

  it('returns null for a JSON string (not an object)', () => {
    assert.equal(parseCircleCardBody('"hello"'), null);
  });

  it('returns null for a JSON number', () => {
    assert.equal(parseCircleCardBody('42'), null);
  });

  it('returns null for a JSON array', () => {
    assert.equal(parseCircleCardBody('["arrived"]'), null);
  });

  it('returns an empty object for {} — missing subtype field is valid JSON', () => {
    const result = parseCircleCardBody('{}');
    assert.deepEqual(result, {});
  });
});

// ── classifySubtype ───────────────────────────────────────────────────────────

describe('classifySubtype — variant mapping', () => {
  it('classifies "arrived" as checkin', () => {
    assert.equal(classifySubtype('arrived'), 'checkin');
  });

  it('classifies "with_group" as checkin', () => {
    assert.equal(classifySubtype('with_group'), 'checkin');
  });

  it('classifies "leaving" as checkin', () => {
    assert.equal(classifySubtype('leaving'), 'checkin');
  });

  it('classifies "safe" as checkin', () => {
    assert.equal(classifySubtype('safe'), 'checkin');
  });

  it('classifies any unrecognised string as checkin (future-proof)', () => {
    assert.equal(classifySubtype('custom_subtype'), 'checkin');
  });

  it('classifies "meeting_point" as meeting_point', () => {
    assert.equal(classifySubtype('meeting_point'), 'meeting_point');
  });

  it('classifies null as unknown', () => {
    assert.equal(classifySubtype(null), 'unknown');
  });

  it('classifies undefined as unknown', () => {
    assert.equal(classifySubtype(undefined), 'unknown');
  });

  it('classifies empty string as unknown', () => {
    assert.equal(classifySubtype(''), 'unknown');
  });
});

// ── checkinLabel ──────────────────────────────────────────────────────────────

describe('checkinLabel — human-readable label', () => {
  it('maps "arrived" to the correct label', () => {
    assert.equal(checkinLabel('arrived'), 'Arrived at the destination');
  });

  it('maps "with_group" to the correct label', () => {
    assert.equal(checkinLabel('with_group'), 'Checked in with the group');
  });

  it('maps "leaving" to the correct label', () => {
    assert.equal(checkinLabel('leaving'), 'Heading out');
  });

  it('maps "safe" to the correct label', () => {
    assert.equal(checkinLabel('safe'), 'Marked as safe');
  });

  it('maps an unknown subtype to the generic fallback label', () => {
    assert.equal(checkinLabel('anything_else'), 'Checked in');
  });
});

// ── resolveCardRender — full rendering decision ───────────────────────────────

describe('resolveCardRender — privacy placeholder (isCircleMember !== true)', () => {
  it('shows placeholder when isCircleMember is false', () => {
    const result = resolveCardRender('{"subtype":"arrived"}', false, 'Alice');
    assert.deepEqual(result, { show: 'placeholder' });
  });

  it('shows placeholder when isCircleMember is null (loading)', () => {
    const result = resolveCardRender('{"subtype":"arrived"}', null, 'Alice');
    assert.deepEqual(result, { show: 'placeholder' });
  });

  it('shows placeholder when isCircleMember is undefined', () => {
    const result = resolveCardRender('{"subtype":"arrived"}', undefined, null);
    assert.deepEqual(result, { show: 'placeholder' });
  });
});

describe('resolveCardRender — placeholder for unrecognised / missing subtype (member)', () => {
  it('shows placeholder when body is null', () => {
    const result = resolveCardRender(null, true, 'Alice');
    assert.deepEqual(result, { show: 'placeholder' });
  });

  it('shows placeholder when body is malformed JSON', () => {
    const result = resolveCardRender('{not valid', true, 'Alice');
    assert.deepEqual(result, { show: 'placeholder' });
  });

  it('shows placeholder when body is empty string', () => {
    const result = resolveCardRender('', true, 'Alice');
    assert.deepEqual(result, { show: 'placeholder' });
  });

  it('shows placeholder when body is valid JSON but missing subtype field', () => {
    const result = resolveCardRender('{}', true, 'Alice');
    assert.deepEqual(result, { show: 'placeholder' });
  });

  it('shows placeholder when body has explicit null subtype', () => {
    const result = resolveCardRender('{"subtype":null}', true, null);
    assert.deepEqual(result, { show: 'placeholder' });
  });
});

describe('resolveCardRender — check-in card (member, valid subtype)', () => {
  it('shows checkin card for "arrived" subtype', () => {
    const result = resolveCardRender('{"subtype":"arrived"}', true, 'Alice');
    assert.deepEqual(result, { show: 'checkin', subtype: 'arrived', senderName: 'Alice' });
  });

  it('shows checkin card for "with_group" subtype', () => {
    const result = resolveCardRender('{"subtype":"with_group"}', true, 'Bob');
    assert.deepEqual(result, { show: 'checkin', subtype: 'with_group', senderName: 'Bob' });
  });

  it('shows checkin card for "leaving" subtype', () => {
    const result = resolveCardRender('{"subtype":"leaving"}', true, null);
    assert.deepEqual(result, { show: 'checkin', subtype: 'leaving', senderName: null });
  });

  it('shows checkin card for "safe" subtype', () => {
    const result = resolveCardRender('{"subtype":"safe"}', true, 'Carol');
    assert.deepEqual(result, { show: 'checkin', subtype: 'safe', senderName: 'Carol' });
  });

  it('senderName is absent (null) when not provided', () => {
    const result = resolveCardRender('{"subtype":"arrived"}', true, null);
    assert.ok(result.show === 'checkin');
    assert.equal((result as any).senderName, null);
  });
});

describe('resolveCardRender — meeting_point card (member, meeting_point subtype)', () => {
  it('shows meeting_point card with venueLabel', () => {
    const body = '{"subtype":"meeting_point","venueLabel":"Cafe Luna"}';
    const result = resolveCardRender(body, true, 'Dave');
    assert.deepEqual(result, {
      show: 'meeting_point',
      locationText: 'Cafe Luna',
      senderName: 'Dave',
    });
  });

  it('falls back to approxArea when venueLabel is absent', () => {
    const body = '{"subtype":"meeting_point","approxArea":"BGC Area"}';
    const result = resolveCardRender(body, true, 'Eve');
    assert.deepEqual(result, {
      show: 'meeting_point',
      locationText: 'BGC Area',
      senderName: 'Eve',
    });
  });

  it('locationText is null when both venueLabel and approxArea are absent', () => {
    const body = '{"subtype":"meeting_point"}';
    const result = resolveCardRender(body, true, null);
    assert.deepEqual(result, {
      show: 'meeting_point',
      locationText: null,
      senderName: null,
    });
  });

  it('senderName renders when provided', () => {
    const body = '{"subtype":"meeting_point","venueLabel":"The Hub"}';
    const result = resolveCardRender(body, true, 'Frank');
    assert.ok(result.show === 'meeting_point');
    assert.equal((result as any).senderName, 'Frank');
  });

  it('senderName is absent when null', () => {
    const body = '{"subtype":"meeting_point","venueLabel":"The Hub"}';
    const result = resolveCardRender(body, true, null);
    assert.ok(result.show === 'meeting_point');
    assert.equal((result as any).senderName, null);
  });
});

describe('resolveCardRender — subtypeOverride takes precedence over body', () => {
  it('uses subtypeOverride instead of body subtype when both provided', () => {
    const result = resolveCardRender('{"subtype":"meeting_point"}', true, null, 'arrived');
    assert.ok(result.show === 'checkin');
  });

  it('uses subtypeOverride even when body is null', () => {
    const result = resolveCardRender(null, true, 'Alice', 'safe');
    assert.deepEqual(result, { show: 'checkin', subtype: 'safe', senderName: 'Alice' });
  });
});

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
 * malformed input must never produce a blank/crashed card.
 *
 * The component delegates its entire rendering decision to
 * `resolveCardRenderFromProps` (from CircleStatusCardMessage.logic.ts), so
 * testing that function directly is equivalent to testing the component render
 * path.  The `text` field in placeholder decisions and `label` in checkin
 * decisions are the exact strings the component renders.
 *
 * These tests lock in correct behaviour for every edge-case input so a
 * regression is caught at CI time, not at runtime on a device.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEHOLDER_TEXT,
  parseCircleCardBody,
  classifySubtype,
  checkinLabel,
  resolveCardRenderFromProps,
  resolveCardRender,
  circleCardInboxPreview,
} from '../CircleStatusCardMessage.logic.ts';

// ── PLACEHOLDER_TEXT constant ─────────────────────────────────────────────────

describe('PLACEHOLDER_TEXT — privacy-safe placeholder string', () => {
  it('equals the expected user-visible text', () => {
    assert.equal(PLACEHOLDER_TEXT, 'Shared a Circle update.');
  });
});

// ── parseCircleCardBody ───────────────────────────────────────────────────────

describe('parseCircleCardBody — raw body parsing', () => {
  it('parses a valid check-in JSON body', () => {
    const result = parseCircleCardBody('{"subtype":"arrived"}');
    assert.deepEqual(result, { subtype: 'arrived' });
  });

  it('parses a valid meeting_point body with venue and area', () => {
    const result = parseCircleCardBody(
      '{"subtype":"meeting_point","venueLabel":"Cafe Luna","approxArea":"BGC"}',
    );
    assert.deepEqual(result, { subtype: 'meeting_point', venueLabel: 'Cafe Luna', approxArea: 'BGC' });
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

  it('returns null for a JSON primitive string', () => {
    assert.equal(parseCircleCardBody('"hello"'), null);
  });

  it('returns null for a JSON number', () => {
    assert.equal(parseCircleCardBody('42'), null);
  });

  it('returns null for a JSON array', () => {
    assert.equal(parseCircleCardBody('["arrived"]'), null);
  });

  it('returns an empty object for {} — subtype missing but valid JSON', () => {
    assert.deepEqual(parseCircleCardBody('{}'), {});
  });
});

// ── classifySubtype ───────────────────────────────────────────────────────────

describe('classifySubtype — variant mapping', () => {
  it('classifies "arrived" as checkin', () => assert.equal(classifySubtype('arrived'), 'checkin'));
  it('classifies "with_group" as checkin', () => assert.equal(classifySubtype('with_group'), 'checkin'));
  it('classifies "leaving" as checkin', () => assert.equal(classifySubtype('leaving'), 'checkin'));
  it('classifies "safe" as checkin', () => assert.equal(classifySubtype('safe'), 'checkin'));
  it('classifies any unrecognised string as unknown (→ placeholder)', () => assert.equal(classifySubtype('custom_event'), 'unknown'));
  it('classifies "meeting_point" as meeting_point', () => assert.equal(classifySubtype('meeting_point'), 'meeting_point'));
  it('classifies null as unknown', () => assert.equal(classifySubtype(null), 'unknown'));
  it('classifies undefined as unknown', () => assert.equal(classifySubtype(undefined), 'unknown'));
  it('classifies empty string as unknown', () => assert.equal(classifySubtype(''), 'unknown'));
});

// ── checkinLabel ──────────────────────────────────────────────────────────────

describe('checkinLabel — human-readable label', () => {
  it('maps "arrived"', () => assert.equal(checkinLabel('arrived'), 'Arrived at the destination'));
  it('maps "with_group"', () => assert.equal(checkinLabel('with_group'), 'Checked in with the group'));
  it('maps "leaving"', () => assert.equal(checkinLabel('leaving'), 'Heading out'));
  it('maps "safe"', () => assert.equal(checkinLabel('safe'), 'Marked as safe'));
  it('maps unknown to generic fallback', () => assert.equal(checkinLabel('other'), 'Checked in'));
});

// ── resolveCardRenderFromProps — component render path ───────────────────────
//
// This function is what CircleStatusCardMessage calls at render time.
// Asserting `decision.text` / `decision.label` here is equivalent to
// asserting what text the component will render.

describe('resolveCardRenderFromProps — privacy placeholder text (non-member)', () => {
  it('renders PLACEHOLDER_TEXT when isCircleMember is false', () => {
    const r = resolveCardRenderFromProps('arrived', null, null, false, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, PLACEHOLDER_TEXT);
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('renders PLACEHOLDER_TEXT when isCircleMember is null (still loading)', () => {
    const r = resolveCardRenderFromProps('arrived', null, null, null, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('renders PLACEHOLDER_TEXT when isCircleMember is undefined', () => {
    const r = resolveCardRenderFromProps('arrived', null, null, undefined, null);
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });
});

describe('resolveCardRenderFromProps — placeholder for unrecognised / missing subtype (member)', () => {
  it('null subtype → placeholder text', () => {
    const r = resolveCardRenderFromProps(null, null, null, true, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('undefined subtype → placeholder text', () => {
    const r = resolveCardRenderFromProps(undefined, null, null, true, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('empty string subtype → placeholder text', () => {
    const r = resolveCardRenderFromProps('', null, null, true, null);
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });
});

describe('resolveCardRenderFromProps — check-in card label and senderName', () => {
  it('"arrived" → correct label text', () => {
    const r = resolveCardRenderFromProps('arrived', null, null, true, 'Alice');
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Arrived at the destination');
  });

  it('"with_group" → correct label text', () => {
    const r = resolveCardRenderFromProps('with_group', null, null, true, 'Bob');
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Checked in with the group');
  });

  it('"leaving" → correct label text', () => {
    const r = resolveCardRenderFromProps('leaving', null, null, true, null);
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Heading out');
  });

  it('"safe" → correct label text', () => {
    const r = resolveCardRenderFromProps('safe', null, null, true, 'Carol');
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Marked as safe');
  });

  it('senderName is rendered when provided', () => {
    const r = resolveCardRenderFromProps('arrived', null, null, true, 'Alice');
    assert.equal((r as any).senderName, 'Alice');
  });

  it('senderName is null when absent', () => {
    const r = resolveCardRenderFromProps('arrived', null, null, true, null);
    assert.equal((r as any).senderName, null);
  });
});

describe('resolveCardRenderFromProps — meeting_point card locationText and senderName', () => {
  it('uses venueLabel as locationText', () => {
    const r = resolveCardRenderFromProps('meeting_point', 'Cafe Luna', 'BGC', true, 'Dave');
    assert.equal(r.show, 'meeting_point');
    assert.equal((r as any).locationText, 'Cafe Luna');
  });

  it('falls back to approxArea when venueLabel is absent', () => {
    const r = resolveCardRenderFromProps('meeting_point', null, 'BGC Area', true, 'Eve');
    assert.equal(r.show, 'meeting_point');
    assert.equal((r as any).locationText, 'BGC Area');
  });

  it('locationText is null when both venueLabel and approxArea are absent', () => {
    const r = resolveCardRenderFromProps('meeting_point', null, null, true, null);
    assert.equal(r.show, 'meeting_point');
    assert.equal((r as any).locationText, null);
  });

  it('senderName is rendered when provided', () => {
    const r = resolveCardRenderFromProps('meeting_point', 'The Hub', null, true, 'Frank');
    assert.equal((r as any).senderName, 'Frank');
  });

  it('senderName is null when absent', () => {
    const r = resolveCardRenderFromProps('meeting_point', 'The Hub', null, true, null);
    assert.equal((r as any).senderName, null);
  });
});

// ── resolveCardRender — raw body parsing + rendering pipeline ─────────────────
//
// Tests the full end-to-end path: raw JSON body string → parse → decision.
// Covers the same edge cases but via the body string so the JSON-parsing layer
// is exercised in the same pipeline.

describe('resolveCardRender — null / malformed body always shows placeholder (member)', () => {
  it('null body → placeholder', () => {
    const r = resolveCardRender(null, true, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('malformed JSON body → placeholder', () => {
    const r = resolveCardRender('{broken json', true, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('empty string body → placeholder', () => {
    const r = resolveCardRender('', true, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('valid JSON with missing subtype field → placeholder', () => {
    const r = resolveCardRender('{}', true, 'Alice');
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });

  it('valid JSON with explicit null subtype → placeholder', () => {
    const r = resolveCardRender('{"subtype":null}', true, null);
    assert.equal(r.show, 'placeholder');
    assert.equal((r as any).text, 'Shared a Circle update.');
  });
});

describe('resolveCardRender — valid body produces correct card and text', () => {
  it('valid check-in body → checkin card with correct label', () => {
    const r = resolveCardRender('{"subtype":"arrived"}', true, 'Alice');
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Arrived at the destination');
    assert.equal((r as any).senderName, 'Alice');
  });

  it('valid meeting_point body → meeting_point card with locationText', () => {
    const r = resolveCardRender(
      '{"subtype":"meeting_point","venueLabel":"Cafe Luna"}',
      true, 'Bob',
    );
    assert.equal(r.show, 'meeting_point');
    assert.equal((r as any).locationText, 'Cafe Luna');
    assert.equal((r as any).senderName, 'Bob');
  });

  it('subtypeOverride beats body subtype', () => {
    const r = resolveCardRender('{"subtype":"meeting_point"}', true, null, 'arrived');
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Arrived at the destination');
  });

  it('subtypeOverride with null body still resolves correctly', () => {
    const r = resolveCardRender(null, true, 'Alice', 'safe');
    assert.equal(r.show, 'checkin');
    assert.equal((r as any).label, 'Marked as safe');
    assert.equal((r as any).senderName, 'Alice');
  });
});

// ── circleCardInboxPreview ────────────────────────────────────────────────────

describe('circleCardInboxPreview — thread-list preview text for circle cards', () => {
  it('null body → fallback text', () => {
    assert.equal(circleCardInboxPreview(null), 'Circle update');
  });

  it('empty string body → fallback text', () => {
    assert.equal(circleCardInboxPreview(''), 'Circle update');
  });

  it('malformed JSON body → fallback text', () => {
    assert.equal(circleCardInboxPreview('{bad json}'), 'Circle update');
  });

  it('unknown subtype → fallback text', () => {
    assert.equal(circleCardInboxPreview('{"subtype":"future_unknown_value"}'), 'Circle update');
  });

  it('missing subtype field → fallback text', () => {
    assert.equal(circleCardInboxPreview('{"venueLabel":"Park"}'), 'Circle update');
  });

  it('arrived subtype → check-in label', () => {
    assert.equal(circleCardInboxPreview('{"subtype":"arrived"}'), '✓ Circle check-in');
  });

  it('with_group subtype → check-in label', () => {
    assert.equal(circleCardInboxPreview('{"subtype":"with_group"}'), '✓ Circle check-in');
  });

  it('leaving subtype → check-in label', () => {
    assert.equal(circleCardInboxPreview('{"subtype":"leaving"}'), '✓ Circle check-in');
  });

  it('safe subtype → check-in label', () => {
    assert.equal(circleCardInboxPreview('{"subtype":"safe"}'), '✓ Circle check-in');
  });

  it('meeting_point subtype → meeting-point label', () => {
    assert.equal(circleCardInboxPreview('{"subtype":"meeting_point"}'), '📍 Meeting point updated');
  });

  it('meeting_point with venueLabel → same meeting-point label (venueLabel ignored for preview)', () => {
    assert.equal(
      circleCardInboxPreview('{"subtype":"meeting_point","venueLabel":"Cafe Luna"}'),
      '📍 Meeting point updated',
    );
  });
});

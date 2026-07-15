/**
 * Pure-logic tests for the stamp overlay lib: coordinate math, defensive
 * parsing of server jsonb, monogram derivation, and payload building.
 * Runs under plain node:test — no React Native imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  clamp01,
  clampOverlayPosition,
  completePayloadFromDraft,
  computeCoverRect,
  draftFromOption,
  draftToRenderData,
  monogramFor,
  overlayLayout,
  overlayOpacityFor,
  parseStampOverlay,
  STAMP_OVERLAY_DEFAULT_POS,
  STAMP_OVERLAY_DEFAULT_SCALE,
  STAMP_OVERLAY_EDIT_MARGIN,
  STAMP_OVERLAY_MAX_SCALE,
  STAMP_OVERLAY_MIN_SCALE,
  STAMP_OVERLAY_WATERMARK_OPACITY,
  type StampOverlayDraft,
  type StampOverlayOption,
} from '../stampOverlay.ts';

const OPTION: StampOverlayOption = {
  stampDefinitionId: '50000000-0000-0000-0000-000000000d01',
  name: 'Tokyo',
  city: 'Tokyo',
  country: 'Japan',
  rarity: 'common',
  artworkUrl: 'https://cdn.example.com/stamps/tokyo.png',
};

function validRaw(): Record<string, unknown> {
  return {
    stampDefinitionId: OPTION.stampDefinitionId,
    label: 'Tokyo',
    city: 'Tokyo',
    country: 'Japan',
    artworkUrl: 'https://cdn.example.com/stamps/tokyo.png',
    artworkPinnedAt: '2026-07-15T00:00:00.000Z',
    style: 'white',
    x: 0.78,
    y: 0.8,
    scale: 0.28,
    rotation: 0,
    opacity: 1,
  };
}

// ── clamps ───────────────────────────────────────────────────────────────────

test('clamp and clamp01 bound values', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp01(1.7), 1);
  assert.equal(clamp01(-0.2), 0);
});

test('clampOverlayPosition keeps the center inside the editable band', () => {
  const m = STAMP_OVERLAY_EDIT_MARGIN;
  assert.deepEqual(clampOverlayPosition(-1, 2), { x: m, y: 1 - m });
  assert.deepEqual(clampOverlayPosition(0.5, 0.5), { x: 0.5, y: 0.5 });
});

// ── opacity ──────────────────────────────────────────────────────────────────

test('overlayOpacityFor defaults watermark translucent, others opaque', () => {
  assert.equal(overlayOpacityFor('watermark'), STAMP_OVERLAY_WATERMARK_OPACITY);
  assert.equal(overlayOpacityFor('white'), 1);
  assert.equal(overlayOpacityFor('dark'), 1);
  assert.equal(overlayOpacityFor('original'), 1);
});

test('overlayOpacityFor honors explicit finite values and clamps them', () => {
  assert.equal(overlayOpacityFor('white', 0.7), 0.7);
  assert.equal(overlayOpacityFor('watermark', 1), 1);
  assert.equal(overlayOpacityFor('white', 99), 1);
  assert.equal(overlayOpacityFor('white', 0), 0.05);
  assert.equal(overlayOpacityFor('watermark', Number.NaN), STAMP_OVERLAY_WATERMARK_OPACITY);
});

// ── layout math ──────────────────────────────────────────────────────────────

test('overlayLayout centers the badge at normalized coords', () => {
  const l = overlayLayout(400, 500, { x: 0.5, y: 0.5, scale: 0.25, style: 'white' });
  assert.equal(l.size, 100);
  assert.equal(l.left, 150); // 200 - 50
  assert.equal(l.top, 200); // 250 - 50
  assert.equal(l.opacity, 1);
});

test('overlayLayout clamps scale into the allowed band', () => {
  const tiny = overlayLayout(400, 500, { x: 0.5, y: 0.5, scale: 0.01, style: 'white' });
  assert.equal(tiny.size, 400 * STAMP_OVERLAY_MIN_SCALE);
  const huge = overlayLayout(400, 500, { x: 0.5, y: 0.5, scale: 3, style: 'white' });
  assert.equal(huge.size, 400 * STAMP_OVERLAY_MAX_SCALE);
});

test('computeCoverRect overflows exactly one axis, centered', () => {
  // 1000x500 image covering a 200x200 container: scale = 0.4 → 400x200
  const r = computeCoverRect(200, 200, 1000, 500);
  assert.equal(r.height, 200);
  assert.equal(r.width, 400);
  assert.equal(r.top, 0);
  assert.equal(r.left, -100);
  assert.equal(r.scale, 0.4);
});

test('computeCoverRect degrades safely on zero dims', () => {
  const r = computeCoverRect(200, 200, 0, 0);
  assert.deepEqual(r, { left: 0, top: 0, width: 200, height: 200, scale: 1 });
});

// ── parseStampOverlay ────────────────────────────────────────────────────────

test('parseStampOverlay accepts a full valid payload', () => {
  const parsed = parseStampOverlay(validRaw());
  assert.ok(parsed);
  assert.equal(parsed.stampDefinitionId, OPTION.stampDefinitionId);
  assert.equal(parsed.label, 'Tokyo');
  assert.equal(parsed.style, 'white');
  assert.equal(parsed.x, 0.78);
  assert.equal(parsed.opacity, 1);
  assert.equal(parsed.artworkPinnedAt, '2026-07-15T00:00:00.000Z');
});

test('parseStampOverlay rejects junk shapes', () => {
  assert.equal(parseStampOverlay(null), null);
  assert.equal(parseStampOverlay(undefined), null);
  assert.equal(parseStampOverlay('stamp'), null);
  assert.equal(parseStampOverlay(42), null);
  assert.equal(parseStampOverlay([validRaw()]), null);
  assert.equal(parseStampOverlay({}), null);
});

test('parseStampOverlay rejects missing or invalid required fields', () => {
  for (const patch of [
    { stampDefinitionId: '' },
    { stampDefinitionId: 7 },
    { label: '' },
    { label: '   ' },
    { label: null },
    { artworkUrl: 'javascript:alert(1)' },
    { artworkUrl: '//cdn.example.com/x.png' },
    { artworkUrl: null },
    { x: 1.5 },
    { x: -0.1 },
    { y: 'top' },
    { y: Number.NaN },
    { scale: null },
  ]) {
    const raw = { ...validRaw(), ...patch };
    assert.equal(parseStampOverlay(raw), null, JSON.stringify(patch));
  }
});

test('parseStampOverlay falls back to white ink on unknown style', () => {
  const parsed = parseStampOverlay({ ...validRaw(), style: 'neon' });
  assert.ok(parsed);
  assert.equal(parsed.style, 'white');
});

test('parseStampOverlay clamps scale and rotation, defaults opacity by style', () => {
  const parsed = parseStampOverlay({
    ...validRaw(),
    style: 'watermark',
    scale: 0.9,
    rotation: 120,
    opacity: undefined,
  });
  assert.ok(parsed);
  assert.equal(parsed.scale, STAMP_OVERLAY_MAX_SCALE);
  assert.equal(parsed.rotation, 45);
  assert.equal(parsed.opacity, STAMP_OVERLAY_WATERMARK_OPACITY);
});

test('parseStampOverlay normalizes non-string city/country to null', () => {
  const parsed = parseStampOverlay({ ...validRaw(), city: 9, country: undefined });
  assert.ok(parsed);
  assert.equal(parsed.city, null);
  assert.equal(parsed.country, null);
});

// ── monogram ─────────────────────────────────────────────────────────────────

test('monogramFor derives airport-code style initials', () => {
  assert.equal(monogramFor('Tokyo'), 'TOK');
  assert.equal(monogramFor('New York'), 'NY');
  assert.equal(monogramFor('Rio de Janeiro'), 'RDJ');
  assert.equal(monogramFor('São Paulo'), 'SP');
  assert.equal(monogramFor(''), 'ST');
  assert.equal(monogramFor('!!!'), 'ST');
});

// ── draft + payload builders ────────────────────────────────────────────────

test('draftFromOption seeds defaults (white ink, bottom-right, default size)', () => {
  const d = draftFromOption(OPTION);
  assert.equal(d.style, 'white');
  assert.equal(d.x, STAMP_OVERLAY_DEFAULT_POS.x);
  assert.equal(d.y, STAMP_OVERLAY_DEFAULT_POS.y);
  assert.equal(d.scale, STAMP_OVERLAY_DEFAULT_SCALE);
  assert.equal(d.label, 'Tokyo');
  assert.equal(d.stampDefinitionId, OPTION.stampDefinitionId);
});

test('draftToRenderData adds rotation 0 and style-derived opacity', () => {
  const base = draftFromOption(OPTION);
  const white = draftToRenderData(base);
  assert.equal(white.rotation, 0);
  assert.equal(white.opacity, 1);
  const wm = draftToRenderData({ ...base, style: 'watermark' });
  assert.equal(wm.opacity, STAMP_OVERLAY_WATERMARK_OPACITY);
});

test('completePayloadFromDraft clamps values and never leaks artwork fields', () => {
  const draft: StampOverlayDraft = {
    ...draftFromOption(OPTION),
    x: 1.4,
    y: -0.2,
    scale: 0.9,
    style: 'dark',
  };
  const payload = completePayloadFromDraft(draft);
  assert.deepEqual(payload, {
    stampDefinitionId: OPTION.stampDefinitionId,
    style: 'dark',
    x: 1,
    y: 0,
    scale: STAMP_OVERLAY_MAX_SCALE,
  });
  assert.equal('artworkUrl' in payload, false);
  assert.equal('label' in payload, false);
});

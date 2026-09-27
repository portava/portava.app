/**
 * Design-system regression guard for census-media §33 (lane T, the owner's H7
 * ruling of 2026-09-27).
 *
 * §33 fixed the contrast failures in the shared sheets Media opens through the
 * design system: two new role tokens (`signalStrong`, `muteStrong`) and ten
 * shared components moved off `faint`, `signal` and `mute` where those miss AA.
 * No existing token changed value. This file proves the change is safe for
 * every OTHER consumer, not only for Media:
 *
 *   1. Every token that existed before §33 keeps its value, so the 5,000-odd
 *      uses of `faint`, `signal` and `mute` elsewhere render exactly as before.
 *   2. The new tokens are the lightest same-hue shades that clear AA on every
 *      ground they are used on.
 *   3. Every consumer of every changed component, and every use of a new
 *      token, is found by scanning app/ and src/ and must match the list below —
 *      a new consumer turns this red until its pairs are measured here.
 *   4. Every pair those components form, on each consumer's own ground, is
 *      measured BEFORE (the colours at e9e0b0404) and AFTER, and the test fails
 *      if any pair got worse, or ends below WCAG AA (text 4.5:1, state marks and
 *      icon-only controls 3:1), or if the recorded counts move.
 *
 * Pure TypeScript — no React, no native modules, no network.
 * Print the table: SHEET_CONTRAST_TABLE=1 node --import tsx --test src/theme/__tests__/sharedSheetContrast.consumers.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { color } from '../tokens.ts';
import { MEDIA_SHEET_PAIRS, SF, SHEET_SURFACES, type Kind, type Needle, type SheetPair, type SheetSurface } from './sharedSheetContrast.pairs.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/theme/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..');

// ── WCAG 2.x (the formulas mediaContrast.test.ts uses) ─────────────────────────

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const p = fn[1].split(',').map((x) => Number(x.trim()));
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) throw new Error(`unparseable colour: ${value}`);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  throw new Error(`unparseable colour: ${value}`);
}
const over = (fg: Rgba, bg: Rgba): Rgba => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const channel = (u8: number) => { const c = u8 / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const luminance = (c: Rgba) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
const contrast = (a: Rgba, b: Rgba) => { const la = luminance(a); const lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
function flatten(layers: readonly string[]): Rgba {
  const [bottom, ...rest] = layers;
  let bg = parseColor(bottom);
  if (bg.a !== 1) throw new Error(`bottom layer must be opaque: ${bottom}`);
  for (const l of rest) bg = over(parseColor(l), bg);
  return bg;
}
function ratioOn(fg: string, layers: readonly string[]): number {
  const bg = flatten(layers);
  return contrast(over(parseColor(fg), bg), bg);
}
/** `hex`'s channels scaled by `k` — a darker shade of the same hue (the method §31 used for #C43B23). */
function scale(hex: string, k: number): string {
  const c = parseColor(hex);
  const h = (x: number) => Math.round(x * k).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
const THRESHOLD: Record<Exclude<Kind, 'decor'>, number> = { text: 4.5, ui: 3 };
/** Two ratios within this are "unchanged" (the precision the census prints). */
const EPS = 0.005;

// ── Source helpers ───────────────────────────────────────────────────────────

const sourceCache = new Map<string, string>();
function source(file: string): string {
  let t = sourceCache.get(file);
  if (t === undefined) { t = readFileSync(join(APP_ROOT, file), 'utf8'); sourceCache.set(file, t); }
  return t;
}
function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(join(APP_ROOT, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(rel);
    }
  }
}
const CLIENT_FILES: readonly string[] = (() => { const f: string[] = []; walk('app', f); walk('src', f); return f; })();

/** The module an import specifier names, extension and platform suffix stripped; null for a package. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith('.')) p = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else if (spec.startsWith('@/')) p = posix.normalize(spec.slice(2));
  else return null;
  return p.replace(/\.(tsx|ts)$/, '').replace(/\.(web|native|ios|android)$/, '');
}
const moduleOf = (file: string) => file.replace(/\.(tsx|ts)$/, '');
/** Files that import (or re-export from) `target`. */
function importersOf(target: string): string[] {
  const want = moduleOf(target);
  return CLIENT_FILES.filter((f) => {
    if (f === target) return false;
    for (const m of source(f).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) if (resolveSpecifier(f, m[1]) === want) return true;
    return false;
  });
}

// ── 1 and 2. The tokens ──────────────────────────────────────────────────────

/** `color` at e9e0b0404, the tree §33 started from. */
const TOKENS_BEFORE = {
  ink: '#11110F', paper: '#FAF9F6', paperRaised: '#FFFFFF', signal: '#FF4D2E', signalDim: '#E5391C', deep: '#0A3D4A',
  haze: '#E8E5DE', mute: '#6B6862', faint: '#9C988F', scrimTop: 'rgba(17,17,15,0)', scrimBottom: 'rgba(17,17,15,0.78)',
  onInk: '#FAF9F6', onInkMute: 'rgba(250,249,246,0.72)', success: '#2E7D5B', warn: '#C8851A',
} as const;

test('every token that existed before §33 keeps its value; §33 only adds signalStrong and muteStrong', () => {
  const now = color as Record<string, string>;
  for (const [k, v] of Object.entries(TOKENS_BEFORE)) assert.equal(now[k], v, `color.${k} changed value — every consumer of it must be re-measured`);
  assert.deepEqual(Object.keys(now).filter((k) => !(k in TOKENS_BEFORE)).sort(), ['muteStrong', 'signalStrong']);
});

// ── 3. Consumers ─────────────────────────────────────────────────────────────

interface Changed {
  file: string;
  /** How a consumer draws what changed: a file that imports the module AND matches this. */
  draws: RegExp;
  consumers: readonly string[];
}
const CHANGED: readonly Changed[] = [
  { file: SF.comments, draws: /<(CommentsSheet|CommentsSection)\b/, consumers: ['app/post/[id].tsx', 'src/components/PostEngagementBar.tsx', 'src/components/media/MediaCommentSheet.tsx'] },
  { file: SF.share, draws: /<ShareSheet\b/, consumers: ['src/components/PostEngagementBar.tsx', 'src/components/media/WatchItemOverlay.tsx', 'src/features/media/components/MediaActionPanels.tsx'] },
  {
    file: SF.placePicker, draws: /<GlobalPlacePicker\b/, consumers: [
      'app/(rent-a-buddy)/become/apply.tsx', 'app/(rent-a-buddy)/buddy-dashboard/requests.tsx', 'app/(rent-a-buddy)/index.tsx', 'app/(rent-a-buddy)/marketplace.tsx',
      'app/(rent-a-buddy)/request-buddy.tsx', 'app/(rent-a-buddy)/search.tsx', 'app/(rent-a-buddy)/waitlist.tsx', 'app/events/create/index.tsx', 'app/gems/submit.tsx',
      'app/memory/edit.tsx', 'app/trip/edit.tsx', 'app/trip/new.tsx', 'src/components/EventComposerSheet.tsx', 'src/components/HighlightComposer.tsx',
      'src/components/ManualCityPicker.tsx', 'src/components/MeetupCreationSheet.tsx', 'src/components/MemoriesTab.tsx', 'src/components/PostcardComposer.tsx',
      'src/components/PulseCreate.tsx', 'src/components/RouteBuilderSheet.tsx', 'src/components/circle/MeetingPointCard.tsx', 'src/components/discovery/DestinationBar.tsx',
      'src/components/itinerary/GeofenceSettingsSheet.tsx', 'src/components/itinerary/PlanItemSheet.tsx', 'src/components/media/AddGemForm.tsx', 'src/components/trip/DestinationListEditor.tsx',
    ],
  },
  {
    file: SF.planPicker, draws: /\busePlanPicker\(|<PlanPickerControllerProvider\b/, consumers: [
      'app/(tabs)/ai.tsx', 'app/(tabs)/discovery.tsx', 'app/_layout.tsx', 'app/meetup/[id].tsx', 'src/components/DiscoveryWall.tsx', 'src/components/PlaceQuickActions.tsx',
      'src/components/PulseFeedCard.tsx', 'src/components/discovery/PlaceCard.tsx', 'src/components/map/MapEntityActionRow.tsx', 'src/components/media/RouteItPlaceSheet.tsx',
      'src/components/media/WatchFeedList.tsx', 'src/features/media/components/MediaActionRail.tsx',
    ],
  },
  { file: SF.disambiguation, draws: /<DisambiguationSheet\b/, consumers: ['src/platform/input-assistance/creation/CreationAssist.tsx'] },
  {
    file: SF.mentionInput, draws: /<MentionInput\b/, consumers: [
      'app/messages/[id].tsx', 'src/components/CommentsSheet.tsx', 'src/components/GroupChatScreen.tsx', 'src/components/HighlightComposer.tsx',
      'src/components/PostcardComposer.tsx', 'src/components/PulseCreate.tsx',
    ],
  },
  {
    file: SF.mentionList, draws: /<MentionSuggestionList\b/, consumers: [
      'app/messages/[id].tsx', 'src/components/CommentsSheet.tsx', 'src/components/GroupChatScreen.tsx', 'src/components/HighlightComposer.tsx',
      'src/components/PostcardComposer.tsx', 'src/components/PulseCreate.tsx',
    ],
  },
  {
    file: SF.dateField, draws: /<(DatePickerField|TimePickerField)\b/, consumers: [
      'app/(rent-a-buddy)/buddy-dashboard/offer.tsx', 'app/(rent-a-buddy)/buddy-dashboard/requests.tsx', 'app/meetup/[id].tsx', 'app/reminders/[id].tsx', 'app/reminders/new.tsx',
      'src/components/AddToPlanSheet.tsx', 'src/components/MeetupCreationSheet.tsx', 'src/components/PlanPickerController.tsx', 'src/components/itinerary/PlanItemSheet.tsx',
    ],
  },
  { file: SF.lockType, draws: /<LockTypeSelector\b/, consumers: ['src/components/AddToPlanSheet.tsx', 'src/components/PlanPickerController.tsx', 'src/components/itinerary/PlanItemSheet.tsx'] },
  // Only the `selected` fallback changed: a consumer is an importer that passes `selected` to an <Avatar … />.
  { file: SF.avatar, draws: /<Avatar\b(?:(?!\/>)[\s\S])*?\bselected\b(?:(?!\/>)[\s\S])*?\/>/, consumers: ['src/components/DiscoveryShareSheet.tsx', 'src/components/ShareSheet.tsx'] },
];

test('every consumer of each changed component is enumerated, from a scan of app/ and src/', () => {
  assert.ok(CLIENT_FILES.length >= 800, `scanned ${CLIENT_FILES.length} files`);
  for (const c of CHANGED) {
    const found = importersOf(c.file).filter((f) => c.draws.test(source(f))).sort();
    assert.deepEqual(found, [...c.consumers].sort(), `${c.file}: its consumers changed — measure the new one's pairs here`);
  }
  // Anti-vacuity: the scan does see importers that draw nothing §33 changed.
  assert.ok(importersOf(SF.avatar).length > 20, 'Avatar has many importers; only two pass `selected`');
  assert.ok(importersOf(SF.lockType).some((f) => !/<LockTypeSelector\b/.test(source(f))), 'LOCK_STYLE / LOCK_LABEL importers draw no selector');
});

test('every use of a new token is in a component this guard measures', () => {
  const changed = new Set(CHANGED.map((c) => c.file));
  for (const token of ['signalStrong', 'muteStrong']) {
    const users = CLIENT_FILES.filter((f) => f !== SF.tokens && new RegExp(`\\bcolor\\.${token}\\b`).test(source(f)));
    assert.ok(users.length > 0, `color.${token} is unused`);
    assert.deepEqual(users.filter((f) => !changed.has(f)), [], `color.${token} is used outside the measured components`);
  }
});

// ── 4. The pairs, on every consumer's ground ─────────────────────────────────

interface ConsumerPair extends SheetPair {
  /** The component whose change the pair belongs to. */
  component: string;
  /** Where the ground comes from: the component's own ground ('intrinsic', the same for every consumer) or one consumer's. */
  consumer: string;
}

/** The component each MEDIA_SHEET_PAIRS id belongs to, by prefix; the embedded components by their own file. */
function componentOf(p: SheetPair): string {
  if (p.id.startsWith('comments.mentions.')) return SF.mentionList;
  if (p.id === 'comments.capWarning') return SF.mentionInput;
  if (p.id.startsWith('comments.')) return SF.comments;
  if (p.id.startsWith('share.avatar.')) return SF.avatar;
  if (p.id.startsWith('share.')) return SF.share;
  if (p.id.startsWith('placePicker.')) return SF.placePicker;
  if (p.id.startsWith('planPicker.date.')) return SF.dateField;
  if (p.id.startsWith('planPicker.lock.')) return SF.lockType;
  if (p.id.startsWith('planPicker.')) return SF.planPicker;
  if (p.id.startsWith('disambiguation.')) return SF.disambiguation;
  throw new Error(`no component for ${p.id}`);
}

const POST: Needle[] = [['app/post/[id].tsx', '<View style={{ flex: 1, backgroundColor: color.paper }}>'], ['app/post/[id].tsx', '<CommentsSection']];
const CAP_WARNING = MEDIA_SHEET_PAIRS.find((p) => p.id === 'comments.capWarning')!;
const LOCK_HINT = MEDIA_SHEET_PAIRS.find((p) => p.id === 'planPicker.lock.hint')!;

const CONSUMER_PAIRS: ConsumerPair[] = [
  // As they render when opened from Media — the sheet paints its own ground, so every consumer sees these.
  ...MEDIA_SHEET_PAIRS.map((p) => ({ ...p, component: componentOf(p), consumer: 'intrinsic' })),
  // CommentsSection draws the same comment rows inline on the post screen's paper.
  ...MEDIA_SHEET_PAIRS.filter((p) => p.list).map((p): ConsumerPair => ({
    ...p, id: p.id.replace(/^comments\./, 'commentsSection.'), on: 'sheetPaper', wasOn: p.wasOn === undefined ? undefined : 'sheetPaper',
    at: [...p.at, ...POST], component: p === CAP_WARNING ? SF.mentionInput : SF.comments, consumer: 'app/post/[id].tsx',
  })),
  { id: 'commentsSection.empty', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [...POST, [SF.comments, "empty: { fontSize: 14, color: color.mute, textAlign: 'center' },"]], component: SF.comments, consumer: 'app/post/[id].tsx' },
  { id: 'commentsSection.loading', fg: color.signal, on: 'sheetPaper', kind: 'ui', at: [...POST, [SF.comments, '<ActivityIndicator color={color.signal} />']], component: SF.comments, consumer: 'app/post/[id].tsx' },
  // MentionInput's hashtag-cap warning sits on whatever holds the input.
  ...([
    ['app/messages/[id].tsx', 'sheetPaperRaised', /compose: \{[^}]*backgroundColor: color\.paperRaised,/],
    ['src/components/GroupChatScreen.tsx', 'sheetPaperRaised', /compose: \{[^}]*backgroundColor: color\.paperRaised,/],
    ['src/components/HighlightComposer.tsx', 'sheetPaper', /sheet: \{\s*backgroundColor: color\.paper,/],
    ['src/components/PostcardComposer.tsx', 'sheetPaper', 'root: { flex: 1, backgroundColor: color.paper },'],
    ['src/components/PulseCreate.tsx', 'sheetPaper', 'page: { flex: 1, backgroundColor: color.paper },'],
  ] as const).map(([file, on, ground]): ConsumerPair => ({
    id: `mentionInput.capWarning.${file}`, fg: CAP_WARNING.fg, was: CAP_WARNING.was, on: on as SheetSurface, kind: 'text',
    at: [[file, '<MentionInput'], [file, ground], ...CAP_WARNING.at.filter(([f]) => f === SF.mentionInput)], component: SF.mentionInput, consumer: file,
  })),
  // LockTypeSelector's hint sits on the sheet that holds the selector.
  ...([
    ['src/components/AddToPlanSheet.tsx', 'sheetPaper', /sheet: \{\s*backgroundColor: color\.paper,/],
    ['src/components/itinerary/PlanItemSheet.tsx', 'sheetWhite', "sheet:         { backgroundColor: '#fff',"],
  ] as const).map(([file, on, ground]): ConsumerPair => ({
    id: `lockType.hint.${file}`, fg: LOCK_HINT.fg, was: LOCK_HINT.was, on: on as SheetSurface, kind: 'text',
    at: [[file, '<LockTypeSelector value={lockType} onChange={setLockType} />'], [file, ground], ...LOCK_HINT.at.filter(([f]) => f === SF.lockType)], component: SF.lockType, consumer: file,
  })),
];

interface Measured { pair: ConsumerPair; before: number; after: number; threshold: number | null }
const MEASURED: Measured[] = CONSUMER_PAIRS.map((pair) => ({
  pair,
  before: ratioOn(pair.was ?? pair.fg, SHEET_SURFACES[pair.wasOn ?? pair.on]),
  after: ratioOn(pair.fg, SHEET_SURFACES[pair.on]),
  threshold: pair.kind === 'decor' ? null : THRESHOLD[pair.kind],
}));
const improved = MEASURED.filter((m) => m.after > m.before + EPS);
const worse = MEASURED.filter((m) => m.after < m.before - EPS);
const unchanged = MEASURED.filter((m) => Math.abs(m.after - m.before) <= EPS);

test('the new tokens are the lightest same-hue shades that clear AA where they are used', () => {
  // signalStrong: text on a light ground or signal tint, and the fill under onInk text. Every such pair:
  const strongText = MEASURED.filter((m) => m.pair.kind === 'text' && (m.pair.fg === color.signalStrong || m.pair.on === 'sheetSignalStrong'));
  assert.ok(strongText.length >= 15, `${strongText.length} signalStrong text pairs`);
  assert.equal(color.signalStrong, scale(color.signal, 0.77), 'signalStrong is signal ×0.77');
  const worstAt = (k: number) => Math.min(...strongText.map((m) => (m.pair.on === 'sheetSignalStrong'
    ? ratioOn(m.pair.fg, [scale(color.signal, k)])
    : ratioOn(scale(color.signal, k), SHEET_SURFACES[m.pair.on]))));
  assert.ok(worstAt(0.77) >= 4.5, `×0.77 reads ${worstAt(0.77).toFixed(3)}`);
  assert.ok(worstAt(0.78) < 4.5, `×0.78 would also clear (${worstAt(0.78).toFixed(3)}) — signalStrong is darker than it needs to be`);
  // muteStrong: secondary text on a haze fill.
  const onHaze = MEASURED.filter((m) => m.pair.fg === color.muteStrong);
  assert.ok(onHaze.length >= 2 && onHaze.every((m) => m.pair.on === 'sheetHaze'));
  assert.equal(color.muteStrong, scale(color.mute, 0.98), 'muteStrong is mute ×0.98');
  assert.ok(ratioOn(color.muteStrong, SHEET_SURFACES.sheetHaze) >= 4.5);
  assert.ok(ratioOn(scale(color.mute, 0.99), SHEET_SURFACES.sheetHaze) < 4.5, 'mute ×0.99 would also clear');
});

test('every consumer pair is anchored in the source: each needle is found in its file', () => {
  const missing: string[] = [];
  for (const p of CONSUMER_PAIRS) for (const [file, needle] of p.at) {
    const text = source(file);
    if (!(typeof needle === 'string' ? text.includes(needle) : needle.test(text))) missing.push(`${p.id}: ${file} does not contain ${String(needle)}`);
  }
  assert.deepEqual(missing, [], 'a component changed a colour this guard measures — re-measure the pair');
  assert.equal(new Set(CONSUMER_PAIRS.map((p) => p.id)).size, CONSUMER_PAIRS.length, 'pair ids are unique');
});

test('no consumer pair got worse, and none that is asserted ends below WCAG AA', () => {
  assert.deepEqual(worse.map((m) => `${m.pair.id}: ${m.before.toFixed(2)} → ${m.after.toFixed(2)}`), []);
  assert.deepEqual(MEASURED.filter((m) => m.threshold !== null && m.after < m.threshold).map((m) => `${m.pair.id}: ${m.after.toFixed(2)} < ${m.threshold}`), []);
});

test('every pair §33 changed was changed for a reason: it was below AA, or it shares a state with one that was', () => {
  const moved = MEASURED.filter((m) => m.pair.was !== undefined || m.pair.wasOn !== undefined);
  // A moved, asserted pair either failed before, or moved with a failing pair it is drawn with.
  const companions = new Set(['share.thread.checkBadge', 'share.avatar.fillSelected', 'comments.inlineSave.spinner', 'share.send.spinner', 'planPicker.confirm.spinner']);
  const unexplained = moved.filter((m) => m.threshold !== null && m.before >= m.threshold && !companions.has(m.pair.id)
    && !m.pair.id.startsWith('commentsSection.') && !m.pair.id.startsWith('mentionInput.') && !m.pair.id.startsWith('lockType.'));
  assert.deepEqual(unexplained.map((m) => `${m.pair.id}: was ${m.before.toFixed(2)}`), []);
});

test('the counts: consumers, pairs, improved, unchanged, worse', () => {
  const consumers = new Set(CHANGED.flatMap((c) => c.consumers));
  const counts = {
    changedComponents: CHANGED.length,
    consumers: consumers.size,
    pairs: MEASURED.length,
    asserted: MEASURED.filter((m) => m.threshold !== null).length,
    improved: improved.length,
    unchanged: unchanged.length,
    worse: worse.length,
    failingBefore: MEASURED.filter((m) => m.threshold !== null && m.before < m.threshold).length,
    failingAfter: MEASURED.filter((m) => m.threshold !== null && m.after < m.threshold).length,
  };
  assert.equal(counts.improved + counts.unchanged + counts.worse, counts.pairs);
  // Recorded in census-media §33. A change to any of these is a change to what §33 claims.
  assert.deepEqual(counts, { changedComponents: 10, consumers: 54, pairs: 203, asserted: 158, improved: 72, unchanged: 131, worse: 0, failingBefore: 63, failingAfter: 0 });
});

test('print the before/after table when SHEET_CONTRAST_TABLE=1', () => {
  if (process.env.SHEET_CONTRAST_TABLE !== '1') return;
  const rows = MEASURED.map((m) => {
    const bar = m.threshold ?? '—';
    const verdict = m.threshold === null ? 'decor' : m.after >= m.threshold ? 'PASS' : 'FAIL';
    const delta = m.after > m.before + EPS ? 'improved' : m.after < m.before - EPS ? 'WORSE' : 'unchanged';
    return `| ${m.pair.id} | ${m.pair.consumer} | ${m.pair.was ?? m.pair.fg} on ${m.pair.wasOn ?? m.pair.on} | ${m.before.toFixed(2)} | ${m.pair.fg} on ${m.pair.on} | ${m.after.toFixed(2)} | ${bar} | ${verdict} | ${delta} |`;
  });
  console.log(['| pair | consumer | before | ratio | after | ratio | bar | result | change |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
});

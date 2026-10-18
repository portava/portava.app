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
import { MEDIA_SHEET_PAIRS, SF, SHEET_SURFACES, ALL_SHEET_SURFACES, SF_NESTED, hexA, type Kind, type Needle, type SheetPair, type SheetSurface } from './sharedSheetContrast.pairs.ts';

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
      'app/memory/edit.tsx', 'app/memory/new.tsx', 'app/trip/edit.tsx', 'app/trip/new.tsx', 'src/components/EventComposerSheet.tsx', 'src/components/HighlightComposer.tsx',
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
  { file: SF.avatar, draws: /<Avatar\b(?:(?!\/>)[\s\S])*?\bselected\b(?:(?!\/>)[\s\S])*?\/>/, consumers: ['src/components/DiscoveryShareSheet.tsx', 'src/components/ShareSheet.tsx'] }, ...changedNested(), // §33.13: the nested sheets, declared at the tail
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
  const changed = new Set([...CHANGED.map((c) => c.file), ...tokenAdopters().map((a) => a.file)]); // tokenAdopters(): measured at the tail
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
  return nestedComponentOf(p); // §33.13: the nested sheets' ids, at the tail (it throws for an unknown id)
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
  // CommentsSection repeats the sheet's reply-context close and input as its own JSX, one indent deeper; each copy is anchored on its own.
  { id: 'commentsSection.replyContext.close', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'ui', at: [...POST, [SF.comments, '\n                <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>\n                  <X size={14} color={color.mute} />']], component: SF.comments, consumer: 'app/post/[id].tsx' },
  { id: 'commentsSection.input.placeholder', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [...POST, [SF.comments, '\n                  placeholder={inputPlaceholder}\n                  placeholderTextColor={color.mute}']], component: SF.comments, consumer: 'app/post/[id].tsx' },
  // MentionInput's hashtag-cap warning sits on whatever holds the input.
  ...([
    ['app/messages/[id].tsx', 'sheetPaperRaised', /compose: \{[^}]*backgroundColor: p\.surfaceRaised,/], // census-telegraph T123: the Telegraph composers read the scheme's palette, whose LIGHT surfaceRaised is #FFFFFF (sheetPaperRaised); the DARK compose bar is not modelled here
    ['src/components/GroupChatScreen.tsx', 'sheetPaperRaised', /compose: \{[^}]*backgroundColor: p\.surfaceRaised,/],
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
  })), ...nestedConsumerPairs(), // §33.13: the attachment tray's error line on its other consumers' grounds, at the tail
];

interface Measured { pair: ConsumerPair; before: number; after: number; threshold: number | null }
const MEASURED: Measured[] = CONSUMER_PAIRS.map((pair) => ({
  pair,
  before: measureRatio(pair.was ?? pair.fg, ALL_SHEET_SURFACES[pair.wasOn ?? pair.on]), // §33.13: floors a photo ground
  after: measureRatio(pair.fg, ALL_SHEET_SURFACES[pair.on]),
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
    : ratioOn(scale(color.signal, k), ALL_SHEET_SURFACES[m.pair.on]))));
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
  const companions = new Set(['share.thread.checkBadge', 'share.avatar.fillSelected', 'comments.inlineSave.spinner', 'share.send.spinner', 'planPicker.confirm.spinner', 'likers.row.followSpinner', 'report.primary.spinner', 'report.source.deniedSettings']);
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
  assert.deepEqual(counts, { changedComponents: 16, consumers: 68, pairs: 310, asserted: 245, improved: 103, unchanged: 207, worse: 0, failingBefore: 89, failingAfter: 0 }); // HM-F08 (TM-create): +1 consumer, app/memory/new.tsx opens GlobalPlacePicker; its pairs are the sheet's own, so pairs do not move. §33.13 (was: assert.deepEqual(counts, { changedComponents: 10, consumers: 54, pairs: 205, asserted: 160, improved: 74, unchanged: 131, worse: 0, failingBefore: 65, failingAfter: 0 }), before the nested sheets)
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

// ═══ census-media §33.13 — the nested sheets, appended at the TAIL so the lines §33 cites do not move ═══
// Function declarations are hoisted, so the lists above can spread what these return; each reads only
// imports, never a later `const`.

/** A photo ground ('PHOTO' at the bottom) is floored over every underlay on a 16-level grid, as mediaContrast.test.ts does. */
function measureRatio(fg: string, layers: readonly string[]): number {
  if (layers[0] !== 'PHOTO') return ratioOn(fg, layers);
  const levels = Array.from({ length: 16 }, (_, i) => i * 17);
  let min = Infinity;
  for (const r of levels) for (const g of levels) for (const b of levels) {
    let bg: Rgba = { r, g, b, a: 1 };
    for (const l of layers.slice(1)) bg = over(parseColor(l), bg);
    const v = contrast(over(parseColor(fg), bg), bg);
    if (v < min) min = v;
  }
  return min;
}

function nestedComponentOf(p: SheetPair): string {
  if (p.id.startsWith('tagPreview.')) return SF_NESTED.tagPreview;
  if (p.id.startsWith('profilePreview.')) return SF_NESTED.profilePreview;
  if (p.id.startsWith('likers.')) return SF_NESTED.likers;
  if (p.id.startsWith('report.photoButton.')) return SF_NESTED.photoButton;
  if (p.id.startsWith('report.source.')) return SF_NESTED.sourceSheet;
  if (p.id.startsWith('report.tray.')) return SF_NESTED.tray;
  if (p.id.startsWith('report.')) return SF_NESTED.report;
  throw new Error(`no component for ${p.id}`);
}

/** The nested sheets §33.13 changed, and every consumer that draws each (MediaPickerButton and AvatarImage did not change). */
function changedNested(): Changed[] {
  return [
    { file: SF_NESTED.tagPreview, draws: /<TagPreviewSheet\b/, consumers: ['src/components/RichText.tsx'] },
    { file: SF_NESTED.profilePreview, draws: /<ProfilePreviewCard\b/, consumers: ['src/components/CommentsSheet.tsx'] },
    { file: SF_NESTED.likers, draws: /<EngagementUserListSheet\b/, consumers: ['src/components/CommentsSheet.tsx', 'src/components/HighlightViewer.tsx', 'src/components/PostEngagementBar.tsx'] },
    // RESTATED by lane tm-telegraph (WP-08, TM-TEL-D4): app/messages/[id].tsx no longer draws ReportSheet — a
    // per-message report now files through the Telegraph route (MessageReportSheet), which snapshots §22 evidence.
    { file: SF_NESTED.report, draws: /<ReportSheet\b/, consumers: [
      'app/(rent-a-buddy)/buddy/[id].tsx', 'app/event/[id].tsx', 'app/map/index.tsx', 'app/post/[id].tsx', 'app/u/[username].tsx',
      'src/components/CommentsSheet.tsx', 'src/components/PulseFeedCard.tsx', 'src/components/ReviewsSection.tsx', 'src/components/ThreadSafetySheet.tsx', 'src/components/map/MapEntityActionRow.tsx',
    ] },
    { file: SF_NESTED.sourceSheet, draws: /<MediaSourceSheet\b/, consumers: ['app/profile/edit/photos.tsx', 'src/components/EventComposerSheet.tsx', 'src/components/MemoriesTab.tsx', 'src/components/ui/MediaPickerButton.tsx'] },
    { file: SF_NESTED.tray, draws: /<MediaAttachmentTray\b/, consumers: ['app/(rent-a-buddy)/become/apply.tsx', 'app/review/[entityType]/[entityId].tsx', 'src/components/ReportSheet.tsx', 'src/components/discovery/SubmitPlaceSheet.tsx'] },
  ];
}

/** MediaAttachmentTray's error line sits on its consumer's ground; ReportSheet's is measured with the sheet. */
function nestedConsumerPairs(): ConsumerPair[] {
  const errorText = MEDIA_SHEET_PAIRS.find((p) => p.id === 'report.tray.errorText');
  if (!errorText) throw new Error('report.tray.errorText is missing from the fixture');
  return ([
    ['src/components/discovery/SubmitPlaceSheet.tsx', /container: \{[^}]*backgroundColor: color\.paper,/],
    ['app/review/[entityType]/[entityId].tsx', "container:    { flex: 1, backgroundColor: '#FAF9F6' },"],
    ['app/(rent-a-buddy)/become/apply.tsx', '<View style={{ flex: 1, backgroundColor: color.paper }}>'],
  ] as const).map(([file, ground]): ConsumerPair => ({
    id: `tray.errorText.${file}`, fg: errorText.fg, was: errorText.was, on: 'sheetPaper', kind: 'text',
    at: [[file, '<MediaAttachmentTray'], [file, ground], ...errorText.at.filter(([f]) => f === SF_NESTED.tray)], component: SF_NESTED.tray, consumer: file,
  }));
}

// ═══ New-token adopters outside §33, appended at the TAIL so the lines §33 cites do not move ═══
// A component §33 did not change may still adopt `signalStrong` / `muteStrong` — that is what the tokens are
// for. It is NOT folded into §33's recorded counts above (those describe §33's own change), but it is held to
// the same proof: its consumers are enumerated from a scan, every pair the new token forms is anchored in the
// source on the ground it is actually drawn on, and every such pair clears WCAG AA. Test 3 above accepts a
// token use only in a file listed here or in CHANGED, so an unmeasured adopter still turns the guard red.

interface TokenAdopter {
  file: string;
  draws: RegExp;
  consumers: readonly string[];
  pairs: readonly AdopterPair[]; // a ConsumerPair that may stand on a trips card's own ground (AdopterPair, at the tail)
}

function tokenAdopters(): TokenAdopter[] {
  const tripSheet = 'src/features/telegraph/composer/PortavaTripShareSheet.tsx';
  // PortavaSheet paints its own ground (s.sheet → color.paperRaised), so every consumer sees the same pair.
  const sheetGround: Needle = ['src/components/ui/PortavaSheet.tsx', /sheet: \{[^}]*backgroundColor: color\.paperRaised,/];
  return [{
    file: tripSheet, draws: /<PortavaTripShareSheet\b/, consumers: ['app/messages/[id].tsx'],
    pairs: [{
      id: 'portavaTripShare.error', fg: color.signalStrong, on: 'sheetPaperRaised', kind: 'text',
      at: [[tripSheet, '<PortavaSheet visible='], [tripSheet, 'error: { ...typography.body, color: color.signalStrong },'], sheetGround],
      component: tripSheet, consumer: 'intrinsic',
    }],
  }, itineraryPasteAdopter(), ...tripsCardAdopters()]; // census-input-intelligence G160: TripItineraryPaste; wave-5 D: its sibling trips cards — both measured at the tail so no line above moves
}

test('every new-token adopter outside §33 is enumerated, anchored, and clears AA on its own ground', () => {
  const adopters = tokenAdopters();
  assert.ok(adopters.length > 0);
  for (const a of adopters) {
    assert.ok(!CHANGED.some((c) => c.file === a.file), `${a.file} is a §33 component — measure it there`);
    const found = importersOf(a.file).filter((f) => a.draws.test(source(f))).sort();
    assert.deepEqual(found, [...a.consumers].sort(), `${a.file}: its consumers changed — measure the new one's pairs here`);
    // Every new-token use in the adopter is one of its measured pairs (by the style line each pair anchors).
    const tokenLines = source(a.file).split('\n').filter((l) => /\bcolor\.(signalStrong|muteStrong)\b/.test(l)).map((l) => l.trim());
    const anchored = new Set(a.pairs.flatMap((p) => p.at.filter(([f, n]) => f === a.file && typeof n === 'string').map(([, n]) => (n as string).trim())));
    assert.deepEqual(tokenLines.filter((l) => !anchored.has(l)), [], `${a.file}: a new-token use with no measured pair`);
    for (const p of a.pairs) {
      for (const [file, needle] of p.at) {
        const text = source(file);
        assert.ok(typeof needle === 'string' ? text.includes(needle) : needle.test(text), `${p.id}: ${file} does not contain ${String(needle)}`);
      }
      assert.notEqual(p.kind, 'decor', `${p.id}: a new-token pair is asserted, never decor`);
      const ratio = measureRatio(p.fg, adopterGround(p.on)); // a shared ground, or a trips card's own (tripsGrounds(), at the tail); an unknown name throws
      const bar = THRESHOLD[p.kind as Exclude<Kind, 'decor'>];
      assert.ok(ratio >= bar, `${p.id}: ${ratio.toFixed(2)} < ${bar}`);
    }
  }
});

/**
 * census-input-intelligence G160: TripItineraryPaste adopts `signalStrong` for what the token is for — vermilion TEXT on a light
 * ground (the "N not added" outcome line; a stop that is blocked, refused or unreachable), the fill under onInk text
 * (the primary "Read times" / "Add N stops" button), and the ticked box's fill beside it.
 *
 * Grounds, as the component renders them. Its own full-screen Modal paints `s.screen` (color.paper); the review list
 * is a ScrollView that paints nothing over it, so the outcome line sits on paper. Each stop is a `s.item` card
 * (color.paperRaised), and the blocked / refused / unreachable lines and the tick box are drawn inside that card. Every
 * pair is therefore intrinsic: TripStructureComposer, the one consumer, only opens the Modal.
 *
 * Not paired: the primary button while disabled (`disabled: { opacity: 0.45 }` — before the paste has text, before a
 * type is chosen or a stop is ticked, and while sending). That is an inactive control (WCAG 1.4.3), which §33 grades
 * `decor` (share.send.disabled, report.primary.disabled) and this section admits only asserted pairs. The busy
 * spinner (`color.onInk`) is drawn only in that disabled state, so it is never on the full fill and is not paired on it.
 */
function itineraryPasteAdopter(): TokenAdopter {
  const f = 'src/features/trips/planning/TripItineraryPaste.tsx';
  const paper: Needle[] = [
    [f, '<View style={s.screen} accessibilityViewIsModal testID="itinerary-paste-sheet">'],
    [f, /\bscreen: \{ flex: 1, backgroundColor: color\.paper,/],
    [f, '<ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: space.sm, paddingBottom: space.lg }}>'],
  ];
  const card: Needle[] = [
    [f, '<View style={s.item} testID={`itinerary-stop-${i}`}>'],
    [f, /\bitem: \{ backgroundColor: color\.paperRaised,/],
  ];
  const primary: Needle[] = [
    [f, "primary: { backgroundColor: color.signalStrong, borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.lg, alignItems: 'center' },"],
    [f, 'style={[s.primary, !text.trim() && s.disabled]} testID="itinerary-paste-read"'],
    [f, 'style={[s.primary, { flex: 1 }, (!batch.type || queue.length === 0 || busy) && s.disabled]}'],
  ];
  const pair = (id: string, fg: string, on: SheetSurface, kind: Kind, at: Needle[]): ConsumerPair =>
    ({ id: `itineraryPaste.${id}`, fg, on, kind, at, component: f, consumer: 'intrinsic' });
  return {
    file: f, draws: /<TripItineraryPaste\b/, consumers: ['src/features/trips/planning/TripStructureComposer.tsx'],
    pairs: [
      pair('outcome.notAllAdded', color.signalStrong, 'sheetPaper', 'text', [...paper,
        [f, '<Text style={[s.bodyStrong, addedCount < results.length && { color: color.signalStrong }]} accessibilityRole="alert" testID="itinerary-outcome">']]),
      pair('stop.blocked', color.signalStrong, 'sheetPaperRaised', 'text', [...card,
        [f, '<Text style={[s.body, { color: color.signalStrong }]} testID={`itinerary-stop-blocked-${i}`}>{blockWords(st)}</Text>']]),
      pair('stop.refused', color.signalStrong, 'sheetPaperRaised', 'text', [...card,
        [f, '<Text style={[s.body, { color: color.signalStrong }]} testID={`itinerary-stop-refused-${i}`}>Not added — {send.result.detail}</Text>']]),
      pair('stop.unavailable', color.signalStrong, 'sheetPaperRaised', 'text', [...card,
        [f, '<Text style={[s.body, { color: color.signalStrong }]} testID={`itinerary-stop-unavailable-${i}`}>']]),
      pair('primary.label', color.onInk, 'sheetSignalStrong', 'text', [...primary,
        [f, 'primaryText: { ...t.bodyStrong, color: color.onInk },'],
        [f, "<Text style={s.primaryText}>{phase === 'error' && error?.retryable ? 'Try again' : 'Read times'}</Text>"]]),
      pair('stop.tickedBox', color.signalStrong, 'sheetPaperRaised', 'ui', [...card,
        [f, '<View style={[s.box, ticked && s.boxOn]} />'],
        [f, 'boxOn: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },']]), pair('input.placeholder', color.mute, 'sheetPaperRaised', 'text', [[f, /\binput: \{ minHeight: 140, \.\.\.t\.body, color: color\.ink, backgroundColor: color\.paperRaised,/], [f, "placeholder={'Friday:\\nMadame Lan at 7pm\\nSky36 at 9pm'} placeholderTextColor={color.mute}"], [f, 'style={s.input} accessibilityLabel="Pasted itinerary" testID="itinerary-paste-input"']]),
    ],
  };
}

// ═══ Wave-5 follow-up D: TripItineraryPaste's sibling trips cards, appended at the TAIL so no line above moves ═══
// The cards drew error, refusal and status TEXT in `signal` (3.14:1 on paper, 3.31:1 on paperRaised, 3.05:1 on its
// own 0x11 badge tint, 3.09:1 on a #FFF5F5 chip), light text on a `signal` fill (onInk 3.14:1, white 3.31:1),
// placeholders, labels and one spinner in `faint` (2.71–2.88:1), and two labels on a haze fill in `mute` (4.41:1).
// Each moved, in place, to the token tokens.ts names for that purpose: vermilion text and the fill under light text
// → signalStrong; faint text, or a faint state mark, on a light ground → mute; secondary text on haze → muteStrong.
// They are held to the adopter proof above (consumers from the scan, needles, every pair at or above its bar) and,
// in the test below, to §33's other rule: every moved pair was below its bar before, unless it is a declared
// companion, a mark that moved only to stay the colour of the failing pair it keys or sits under.
//
// Not paired, by §33's own grading (each is measured in the wave-5 D handback): spinners left in `signal` (state
// marks, 3.14–3.31:1 ≥ 3); an icon beside the text that names it, a card or button outline its label identifies, a
// decorative map marker, a control dimmed by opacity while disabled or busy (1.4.3); the switch track (3.31:1 ≥ 3).
// `warn` text (3.08:1) is not §33's and has no AA token; the first test above admits no new one.

/** Grounds the trips cards paint that the shared lists do not name. */
type TripsGround = 'tripsChipActive' | 'tripsBadgeSignalStrong11' | 'tripsBadgeSignal11' | 'tripsBadgeMute11' | 'tripsBadgeFaint11';
function tripsGrounds(): Record<TripsGround, readonly string[]> {
  return {
    tripsChipActive: ['#FFF5F5'], // CrewMapSection: the chosen visibility chip (vs.chipActive)
    // CrewMemberCard: the status badge is `status.color + '11'` over the paperRaised list card, now and before.
    tripsBadgeSignalStrong11: [color.paperRaised, hexA(color.signalStrong, '11')],
    tripsBadgeSignal11: [color.paperRaised, hexA(color.signal, '11')],
    tripsBadgeMute11: [color.paperRaised, hexA(color.mute, '11')],
    tripsBadgeFaint11: [color.paperRaised, hexA(color.faint, '11')],
  };
}

/** A ConsumerPair whose ground may be a trips card's own; `companion` says why a pair that already passed moved. */
type AdopterPair = Omit<ConsumerPair, 'on' | 'wasOn'> & { on: SheetSurface | TripsGround; wasOn?: SheetSurface | TripsGround; companion?: string };

function adopterGround(on: SheetSurface | TripsGround): readonly string[] {
  const g = (ALL_SHEET_SURFACES as Partial<Record<string, readonly string[]>>)[on] ?? (tripsGrounds() as Partial<Record<string, readonly string[]>>)[on];
  if (!g) throw new Error(`no ground named ${on}`);
  return g;
}

/**
 * The trips cards, each a measured adopter. Grounds as each renders: a card paints its own `s.wrap`
 * (color.paperRaised), or LiveShareSheet its own sheet, so its pairs are intrinsic and the consumer the scan finds
 * (app/trip/[id].tsx for most) only places it. Components that paint no ground are measured on the card that draws
 * them: StructureDetailFields on TripStructureComposer; TripProposalComposer on TripBallotsCard; ZonedTimeField on
 * TripStageControls and, through StructureDetailFields, on TripStructureComposer; CrewMemberCard on CrewMapSection's
 * list card; ArrivalBoard's spinner on the trip screen's paper (CrewMapSection's wrap paints nothing).
 */
function tripsCardAdopters(): TokenAdopter[] {
  const T = 'src/features/trips/';
  const TRIP = 'app/trip/[id].tsx';
  const today = `${T}today/TripTodayCard.tsx`, att = `${T}plans/TripPlanAttendanceCard.tsx`, stg = `${T}stages/TripStageControls.tsx`;
  const bal = `${T}planning/TripBallotsCard.tsx`, tsc = `${T}planning/TripStructureComposer.tsx`, tp = `${T}planning/TripTransportPolicyCard.tsx`;
  const sdf = `${T}planning/StructureDetailFields.tsx`, prop = `${T}planning/TripProposalComposer.tsx`, prv = `${T}planning/TripPlanPrivacyCard.tsx`;
  const dc = `${T}planning/TripDecisionComposer.tsx`, fz = `${T}planning/TripFeasibilityCard.tsx`, lc = `${T}lifecycle/TripLifecycleCard.tsx`;
  const jr = `${T}joinRequests/JoinRequestsList.tsx`, sc = `${T}sharedContent/TripSharedContentSection.tsx`, pt = `${T}closeout/TripPostTripCard.tsx`;
  const co = `${T}closeout/TripCloseoutCard.tsx`, tc = `${T}timeline/TripTimelineConflictsCard.tsx`, rsc = `${T}disruption/TripRescueEntry.tsx`;
  const ztf = `${T}shared/ZonedTimeField.tsx`, cmc = `${T}crew/CrewMemberCard.tsx`, cms = `${T}crew/CrewMapSection.tsx`;
  const lss = `${T}crew/LiveShareSheet.tsx`, ab = `${T}crew/ArrivalBoard.tsx`, tps = `${T}planning/TripPlanSection.tsx`;

  const card = (file: string, draws: RegExp, consumers: string[], pairs: AdopterPair[]): TokenAdopter => ({ file, draws, consumers, pairs });
  const pair = (file: string, id: string, fg: string, was: string, on: AdopterPair['on'], kind: 'text' | 'ui', at: Needle[], more: Partial<AdopterPair> = {}): AdopterPair =>
    ({ id: `trips.${id}`, fg, was, on, kind, at, component: file, consumer: 'intrinsic', ...more });
  /** The card's own paperRaised ground: its `wrap` style, and the wrapper the pair is drawn inside. */
  const raised = (file: string, wrapper: string): Needle[] => [[file, /\bwrap: \{[^}]*backgroundColor: color\.paperRaised,/], [file, wrapper]];
  /** Vermilion text on the card's paperRaised ground, moved off `signal`. */
  const err = (file: string, id: string, wrapper: string, line: string, more: Needle[] = []): AdopterPair =>
    pair(file, id, color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...raised(file, wrapper), ...more, [file, line]]);
  /** Faint text (a label or a placeholder) on the card's paperRaised ground, moved to `mute`. */
  const faint = (file: string, id: string, wrapper: string, line: string, more: Needle[] = []): AdopterPair =>
    pair(file, id, color.mute, color.faint, 'sheetPaperRaised', 'text', [...raised(file, wrapper), ...more, [file, line]]);
  /** A text input that paints no fill: its placeholder sits on whatever holds it. */
  const unfilledInput = (file: string): Needle => [file, /\binput: \{(?:(?!backgroundColor)[^}])*\}/];

  const todayCard = '<View style={[s.wrap, alarm && s.wrapAlarm]} testID="trip-today-card">';
  const attCard = '<View style={s.wrap} testID="plan-attendance-card">';
  const stgCard = '<View style={s.wrap} testID="stage-controls">';
  const balCard = '<View style={s.wrap} testID="trip-ballots-card">';
  const tscCard = '<View style={s.wrap} testID="trip-structure-composer">';
  const tpCard = '<View style={s.wrap} testID="trip-transport-card">';
  const prvCard = '<View style={s.wrap} testID="trip-plan-privacy-card">';
  const dcCard = '<View style={s.wrap} testID="trip-decision-composer">';
  const lcCard = '<View style={s.wrap} testID="trip-lifecycle-card">';
  const jrCard = '<View style={s.wrap} testID="join-requests-card">';
  const scCard = '<View style={s.wrap} testID="trip-shared-content">';
  const ptCard = '<View style={s.wrap} testID="trip-posttrip-card">';
  const tcCard = '<View style={[s.wrap, s.wrapAlarm]} testID="trip-conflicts-card">';
  const rscCard = '<View style={[s.wrap, s.wrapAlarm]} testID="trip-rescue-entry">';

  // Grounds borrowed from the card that draws a component which paints none.
  const boundsInComposer: Needle[] = [[tsc, '<StageBoundsFields value={bounds}'], ...raised(tsc, tscCard)];
  const detailsInComposer: Needle[] = [[tsc, '<CommitmentDetailsFields value={details}'], ...raised(tsc, tscCard)];
  const inBallots: Needle[] = [[bal, '<TripProposalComposer key="proposal-composer"'], ...raised(bal, balCard), [prop, 'block: { paddingHorizontal: space.lg, paddingVertical: space.sm },'], unfilledInput(prop)];
  const zonedInStages: Needle[] = [[stg, '<ZonedTimeField label="Starts" zone={st.timezone}'], [stg, '<View testID={`stage-control-form-${st.id}`}>'], ...raised(stg, stgCard)];
  const zonedInFields: Needle[] = [[sdf, '<ZonedTimeField label="Starts" zone={zone}'], [sdf, '<View testID="stage-bounds-fields">'], ...boundsInComposer];
  const zonedOwn: Needle[] = [[ztf, '<View testID={testID}>'], unfilledInput(ztf)];
  const inList: Needle[] = [
    [cms, '<CrewMemberCard'], [cms, '<View style={s.listCard}>'], [cms, /\blistCard: \{\s*backgroundColor: color\.paperRaised,/],
    [cmc, /\bcard: \{(?:(?!backgroundColor)[^}])*\}/], // the member row paints nothing
  ];
  const badge: Needle[] = [...inList,
    [cmc, "<View style={[s.badge, { borderColor: status.color + '33', backgroundColor: status.color + '11' }]}>"],
    [cmc, '<Text style={[s.badgeText, { color: status.color }]}>{status.label}</Text>']];
  const lssSheet: Needle[] = [[lss, '<View style={s.sheet}>'], [lss, /\bsheet: \{\s*backgroundColor: color\.paperRaised,/]];
  const scPrimary: Needle = [sc, 'primary: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },'];
  const scLabel = (id: string, line: string): AdopterPair =>
    pair(sc, id, '#FFFFFF', '#FFFFFF', 'sheetSignalStrong', 'text', [...raised(sc, scCard), scPrimary, [sc, line]], { wasOn: 'sheetSignal' });
  const zoned = (consumer: string, ground: Needle[]): AdopterPair[] => [
    // An input whose zone is unknown is dimmed and not editable (s.closed) — a disabled control, decor; these are the open ones.
    pair(ztf, `zonedTime.date.placeholder.${consumer}`, color.mute, color.faint, 'sheetPaperRaised', 'text',
      [...ground, ...zonedOwn, [ztf, 'placeholder="YYYY-MM-DD" placeholderTextColor={color.mute} maxLength={10} autoCorrect={false}']], { consumer }),
    pair(ztf, `zonedTime.time.placeholder.${consumer}`, color.mute, color.faint, 'sheetPaperRaised', 'text',
      [...ground, ...zonedOwn, [ztf, 'placeholder="HH:MM" placeholderTextColor={color.mute} maxLength={5} autoCorrect={false}']], { consumer }),
    pair(ztf, `zonedTime.problem.${consumer}`, color.signalStrong, color.signal, 'sheetPaperRaised', 'text',
      [...ground, ...zonedOwn, [ztf, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`${testID}-problem`}>{problem}</Text>']], { consumer }),
  ];

  return [
    card(today, /<TripTodayCard\b/, [TRIP], [
      err(today, 'today.attention.title', todayCard, '<Text style={[s.title, { color: color.signalStrong }]}>{banner.title}</Text>',
        [[today, '<View style={[s.row, s.banner]} testID="trip-today-attention">'], [today, 'banner: { borderBottomWidth: 1, borderBottomColor: color.haze },']]),
      err(today, 'today.action.critical', todayCard, "<Text key={`${u.kind}-${i}`} style={[s.detail, u.severity === 'critical' && { color: color.signalStrong }]}>",
        [[today, '<View style={s.actions} testID="trip-today-actions">'], [today, 'actions: { paddingHorizontal: space.lg, paddingBottom: space.sm },']]),
      err(today, 'today.phase.name', todayCard, "phaseTitle: { ...t.stamp, color: color.signalStrong, fontWeight: '700', letterSpacing: 0.5 },",
        [[today, '<View style={s.phase} testID="trip-today-phase">'], [today, 'phase: { marginTop: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },'],
          [today, '<Text style={s.phaseTitle} testID="trip-today-phase-name">']]),
      err(today, 'today.navigate.label', todayCard, "navText: { ...t.stamp, color: color.signalStrong, fontWeight: '600' },",
        [[today, "navButton: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },"], [today, '<Text style={s.navText}>Navigate to {today.currentPlan.locationName}</Text>']]),
      faint(today, 'today.answer.question', todayCard, 'question: { ...t.stamp, color: color.mute },', [[today, '<Text style={s.question}>{a.question}</Text>']]),
      faint(today, 'today.sensing', todayCard, 'sensing: { ...t.stamp, color: color.mute, paddingHorizontal: space.lg, paddingBottom: space.md },',
        [[today, '<Text style={s.sensing} testID="trip-today-sensing">{sensingLine(today)}</Text>']]),
    ]),
    card(att, /<TripPlanAttendanceCard\b/, [TRIP], [
      err(att, 'attendance.readFailed', '<View style={s.wrap} testID="plan-attendance-read-failed">',
        '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t read this trip&apos;s plans and who&apos;s going — {detail}. That isn&apos;t the same as nobody going.</Text>'),
      err(att, 'attendance.refused', attCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`plan-attendance-refused-${plan.id}`}>Not changed — {res.detail}</Text>'),
      err(att, 'attendance.unreached', attCard, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was changed.</Text>',
        [[att, '<View testID={`plan-attendance-unavailable-${plan.id}`}>']]),
    ]),
    card(stg, /<TripStageControls\b/, [TRIP], [
      err(stg, 'stages.readFailed', '<View style={s.wrap} testID="stage-controls-read-failed">',
        '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t read this trip&apos;s stages — {read.detail}. That isn&apos;t the same as it having none.</Text>'),
      err(stg, 'stages.datesProblem', stgCard, "{draft && draft.where === 'group' ? <Text style={[s.detail, { color: color.signalStrong }]} testID={`stage-control-problem-${st.id}`}>{draft.problem}</Text> : null}",
        [[stg, '<View testID={`stage-control-form-${st.id}`}>']]),
      err(stg, 'stages.refused', stgCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`stage-control-refused-${st.id}`}>Not changed — {res.detail}</Text>'),
      err(stg, 'stages.unreached', stgCard, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was changed.</Text>',
        [[stg, '<View testID={`stage-control-unavailable-${st.id}`}>']]),
    ]),
    card(bal, /<TripBallotsCard\b/, [TRIP], [
      err(bal, 'ballots.refused', balCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`ballot-refused-${p.id}`}>Not recorded — {res.detail}</Text>'),
      err(bal, 'ballots.unreached', balCard, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was counted.</Text>'),
    ]),
    card(tsc, /<TripStructureComposer\b/, [TRIP], [
      // The bare opening tag is a prefix of the lines below it too, so it is also anchored with the line it opens.
      err(tsc, 'structure.readFailed', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]}>',
        [[tsc, "<Text style={[s.detail, { color: color.signalStrong }]}>\n                  Couldn&apos;t read this trip&apos;s stages — {structure.state === 'off' ? 'not signed in' : structure.detail}"]]),
      err(tsc, 'structure.cityUnmatched', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID="stage-city-unmatched">That city couldn&apos;t be matched to a known city. Choose it again.</Text>'),
      err(tsc, 'structure.zoneMissing', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]}>No time zone is known for that city.</Text>'),
      err(tsc, 'structure.legSameStage', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID="leg-same-stage">A leg needs two different stages.</Text>'),
      err(tsc, 'structure.goalsFailed', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID="goal-list-failed">'),
      err(tsc, 'structure.refused', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID="structure-compose-refused">Not added — {res.detail}</Text>'),
      err(tsc, 'structure.unreached', tscCard, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was added.</Text>'),
    ]),
    card(tp, /<TripTransportPolicyCard\b/, [TRIP], [
      err(tp, 'transport.notSaved', tpCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID="trip-transport-not-saved">{writeFailureText(result)}</Text>'),
      // Save's white label on its own fill. `disabled={saving}` swaps the label for a spinner, so the label is never dimmed.
      pair(tp, 'transport.save.label', '#FFFFFF', '#FFFFFF', 'sheetSignalStrong', 'text', [...raised(tp, tpCard),
        [tp, 'save: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },'],
        [tp, '<Pressable onPress={() => void onSave()} disabled={saving} style={[s.button, s.save]} testID="trip-transport-save" accessibilityRole="button">'],
        [tp, "buttonTextOn: { color: '#fff' },"], [tp, '<Text style={[s.buttonText, s.buttonTextOn]}>Save transport rules</Text>']], { wasOn: 'sheetSignal' }),
    ]),
    card(sdf, /<(StageBoundsFields|CommitmentDetailsFields)\b/, [tsc], [
      pair(sdf, 'fields.boundsProblem', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...boundsInComposer, [sdf, '<View testID="stage-bounds-fields">'],
        [sdf, '<Text style={[s.detail, { color: color.signalStrong }]} testID="stage-bounds-problem">{draft.problem}</Text>']], { consumer: tsc }),
      pair(sdf, 'fields.zoneMissing', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...detailsInComposer, [sdf, '<View testID="commitment-zone-missing">'],
        [sdf, '<Text style={[s.detail, { color: color.signalStrong }]}>No time zone is known for this trip or stage, so times can&apos;t be set yet.</Text>']], { consumer: tsc }),
      pair(sdf, 'fields.detailsProblem', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...detailsInComposer, [sdf, '<View testID="commitment-details-fields">'],
        [sdf, "{draft.where === 'group' ? <Text style={[s.detail, { color: color.signalStrong }]} testID=\"commitment-details-problem\">{draft.problem}</Text> : null}"]], { consumer: tsc }),
      pair(sdf, 'fields.minutes.placeholder', color.mute, color.faint, 'sheetPaperRaised', 'text', [...detailsInComposer, [sdf, '<MinutesField label="Still fine if late by"'], unfilledInput(sdf),
        [sdf, 'value={value} onChangeText={onChange} keyboardType="number-pad" maxLength={5} placeholder="—" placeholderTextColor={color.mute}']], { consumer: tsc }),
    ]),
    card(prop, /<TripProposalComposer\b/, [bal], [
      pair(prop, 'proposal.title.placeholder', color.mute, color.faint, 'sheetPaperRaised', 'text', [...inBallots, [prop, 'placeholder="What are you proposing?" placeholderTextColor={color.mute}']], { consumer: bal }),
      pair(prop, 'proposal.rationale.placeholder', color.mute, color.faint, 'sheetPaperRaised', 'text', [...inBallots, [prop, 'placeholder="Why? (optional)" placeholderTextColor={color.mute}']], { consumer: bal }),
      pair(prop, 'proposal.impact.placeholder', color.mute, color.faint, 'sheetPaperRaised', 'text', [...inBallots, [prop, 'placeholder="What would it change? (optional)" placeholderTextColor={color.mute}']], { consumer: bal }),
      pair(prop, 'proposal.refused', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...inBallots,
        [prop, '<Text style={[s.detail, { color: color.signalStrong }]} testID="proposal-compose-refused">Not proposed — {res.detail}</Text>']], { consumer: bal }),
      pair(prop, 'proposal.unreached', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...inBallots,
        [prop, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was proposed.</Text>']], { consumer: bal }),
    ]),
    card(prv, /<TripPlanPrivacyCard\b/, [TRIP], [
      err(prv, 'privacy.readFailed', prvCard, '<Text style={[s.detail, { color: color.signalStrong }]}>', [[prv, '<View testID="plan-privacy-read-failed">'],
        [prv, "<Text style={[s.detail, { color: color.signalStrong }]}>\n                Couldn&apos;t read this trip&apos;s plan — {read.state === 'off' ? 'not signed in' : read.detail}"]]),
      err(prv, 'privacy.refused', prvCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`plan-privacy-refused-${item.id}`}>Not changed — {res.detail}</Text>'),
      err(prv, 'privacy.unreached', prvCard, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing changed.</Text>'),
    ]),
    card(dc, /<TripDecisionComposer\b/, [TRIP], [
      faint(dc, 'decision.consequence.placeholder', dcCard, 'placeholder="If nothing is decided… (optional)" placeholderTextColor={color.mute}', [unfilledInput(dc)]),
      faint(dc, 'decision.riskNote.placeholder', dcCard, 'placeholder="What would set it off? (optional)" placeholderTextColor={color.mute}', [unfilledInput(dc)]),
      err(dc, 'decision.refused', dcCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID="decision-compose-refused">Not added — {res.detail}</Text>'),
      err(dc, 'decision.unreached', dcCard, '<Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was added.</Text>'),
    ]),
    card(fz, /<TripFeasibilityCard\b/, [TRIP], [
      err(fz, 'feasibility.infeasible.headline', '<View style={[s.wrap, (infeasible || inconsistent) && s.wrapAlarm]} testID="trip-feasibility-card">',
        '<Text style={[s.title, infeasible && { color: color.signalStrong }]}>'),
    ]),
    card(lc, /<TripLifecycleCard\b/, [TRIP], [
      // Cancel / Delete are outlined, not filled, so the label sits on the card. Busy dims every button (opacity) — decor.
      err(lc, 'lifecycle.dangerLabel', lcCard, "<Text style={[s.buttonText, (a === 'delete' || a === 'cancel') && { color: color.signalStrong }]}>{ACTION_COPY[a].label}</Text>",
        [[lc, /\bbutton: \{(?:(?!backgroundColor)[^}])*\}/]]),
      err(lc, 'lifecycle.refused', lcCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`trip-lifecycle-refused-${last.action}`}>'),
      err(lc, 'lifecycle.unreached', lcCard, '<Text style={[s.detail, { color: color.signalStrong }]}>{writeFailureText(last.result)}</Text>'),
      err(lc, 'lifecycle.retryLink', lcCard, "link: { ...t.stamp, color: color.signalStrong, fontWeight: '600' },",
        [[lc, '<Pressable onPress={() => void run()} testID="trip-lifecycle-retry" accessibilityRole="button"><Text style={s.link}>Retry</Text></Pressable>']]),
    ]),
    card(jr, /<JoinRequestsList\b/, [TRIP, 'app/trip/join-requests.tsx'], [
      err(jr, 'joinRequests.failed', jrCard, '<Text style={[s.detail, { color: color.signalStrong }]} testID={`join-request-failed-${r.id}`}>{writeFailureText(res)}</Text>'),
      err(jr, 'joinRequests.reviewAllLink', jrCard, "link: { ...t.small, color: color.signalStrong, fontWeight: '600' },",
        [[jr, '<Pressable onPress={onOpenAll} testID="join-requests-open-all" accessibilityRole="link"><Text style={s.link}>Review all</Text></Pressable>']]),
    ]),
    card(sc, /<TripSharedContentSection\b/, [TRIP], [
      err(sc, 'shared.writeError', scCard, 'return <Text style={[s.detail, s.pad, { color: color.signalStrong }]} testID="shared-write-error">{writeFailureText(w)}</Text>;',
        [[sc, '<WriteError w={err} />'], [sc, 'form: { paddingHorizontal: space.lg, gap: space.xs },']]),
      err(sc, 'shared.documentOpenFailed', scCard, ": o?.state === 'unavailable' ? <Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t open it ({o.detail}).</Text>",
        [[sc, '<Pressable key={d.id} style={s.item} onPress={() => void toggle(d.id)}'], [sc, 'item: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: color.haze },']]),
      err(sc, 'shared.reminderFormError', scCard, '{formErr ? <Text style={[s.detail, { color: color.signalStrong }]}>{formErr}</Text> : null}',
        [[sc, 'form: { paddingHorizontal: space.lg, gap: space.xs },']]),
      // The primary buttons' white labels on their own fill. Busy or empty, a button is dimmed (opacity 0.5) — decor.
      scLabel('shared.addNote.label', "<Text style={[s.smallBtnText, { color: '#fff' }]}>{busy ? 'Saving…' : 'Add note'}</Text>"),
      scLabel('shared.addDocument.label', "<Text style={[s.smallBtnText, { color: '#fff' }]}>{busy ? 'Saving…' : 'Add document'}</Text>"),
      scLabel('shared.addReminder.label', "testID=\"shared-reminder-add\" accessibilityRole=\"button\"><Text style={[s.smallBtnText, { color: '#fff' }]}>Add</Text></Pressable>"),
      pair(sc, 'shared.addChecklist.icon', '#FFFFFF', '#FFFFFF', 'sheetSignalStrong', 'ui', [...raised(sc, scCard), scPrimary,
        [sc, 'testID="shared-checklist-add" accessibilityRole="button"><Plus size={14} color="#fff" /></Pressable>']],
        { wasOn: 'sheetSignal', companion: 'an icon-only button, 3.31:1 already; it shares `s.primary` with the three labels that failed' }),
    ]),
    card(pt, /<TripPostTripCard\b/, [TRIP], [
      err(pt, 'postTrip.notSaved', ptCard, '{k && !k.ok ? <Text style={[s.detail, { color: color.signalStrong }]}>Not saved — {k.message}</Text> : null}'),
      err(pt, 'postTrip.memoryLink', ptCard, "link: { ...t.stamp, color: color.signalStrong, fontWeight: '600', marginTop: 2 },",
        [[pt, '<Text style={s.link}>Kept as a memory'], [pt, '<Text style={s.link}>Open</Text>']]),
    ]),
    card(co, /<TripCloseoutCard\b/, [TRIP], [
      err(co, 'closeout.notRecorded', '<View style={s.wrap} testID="trip-closeout-card">',
        '<Text style={[s.detail, { color: color.signalStrong }]} testID={`trip-closeout-not-recorded-${q.planId}`}>',
        [[co, 'question: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs },']]),
    ]),
    card(tc, /<TripTimelineConflictsCard\b/, [TRIP], [
      err(tc, 'conflicts.headline', tcCard, '<Text style={[s.title, { color: color.signalStrong }]}>',
        [[tc, "<Text style={[s.title, { color: color.signalStrong }]}>\n            {days.length === 1 ? '1 day has a conflict' : `${days.length} days have conflicts`}"]]),
      faint(tc, 'conflicts.reading', tcCard, 'reading: { ...t.stamp, color: color.mute, marginTop: space.sm },', [[tc, '<Text style={s.reading}>{read.timeline.atRiskReading}</Text>']]),
    ]),
    card(rsc, /<TripRescueEntry\b/, [TRIP], [
      err(rsc, 'rescue.headline', rscCard, '<Text style={[s.title, { color: color.signalStrong }]}>Need help right now?</Text>'),
      faint(rsc, 'rescue.step.who', rscCard, 'who: { ...t.stamp, color: color.mute },',
        [[rsc, '<View style={s.plan} testID="trip-rescue-plan">'], [rsc, '<Text style={s.who}>({st.who})</Text>']]),
    ]),
    card(ztf, /<ZonedTimeField\b/, [stg, sdf], [...zoned(stg, zonedInStages), ...zoned(sdf, zonedInFields)]),
    card(cmc, /<CrewMemberCard\b/, [cms], [
      // A badge's label and its tint are both `status.color`, so a status that moved took its tint with it.
      pair(cmc, 'crewMember.badge.notSharing', color.mute, color.faint, 'tripsBadgeMute11', 'text',
        [...badge, [cmc, "return { label: 'Not sharing', color: color.mute, icon: <EyeOff size={12} color={color.faint} /> };"]], { consumer: cms, wasOn: 'tripsBadgeFaint11' }),
      pair(cmc, 'crewMember.badge.live', color.signalStrong, color.signal, 'tripsBadgeSignalStrong11', 'text',
        [...badge, [cmc, 'color: color.signalStrong,'], [cmc, "label: expiry ? `Live · ${expiry}` : 'Live sharing',\n        color: color.signalStrong,"]], { consumer: cms, wasOn: 'tripsBadgeSignal11' }),
      pair(cmc, 'crewMember.badge.unknown', color.mute, color.faint, 'tripsBadgeMute11', 'text',
        [...badge, [cmc, "return { label: 'Unknown', color: color.mute, icon: <MapPin size={12} color={color.faint} /> };"]], { consumer: cms, wasOn: 'tripsBadgeFaint11' }),
      pair(cmc, 'crewMember.presence.live', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [...inList,
        [cmc, "const lineColor = !positionIsCurrent ? color.mute : member.freshnessClass === 'LIVE' ? color.signalStrong : color.deep;"],
        [cmc, '<Text style={[s.areaLabel, { color: lineColor }]} testID="crew-member-presence-line">{line}</Text>']], { consumer: cms }),
    ]),
    // CrewMapSection reaches the trip screen as TripPage's re-export `TripCrewSection`: TripPage is the importer the scan sees.
    card(cms, /<CrewMapSection\b|\bCrewMapSection as TripCrewSection\b/, ['src/components/TripPage.tsx'], [
      pair(cms, 'crewMap.cluster.live.count', color.onInk, color.onInk, 'sheetSignalStrong', 'text', [
        [cms, "<View style={[dm.clusterDot, { top: '35%', left: '30%', backgroundColor: color.signalStrong }]} testID=\"crew-density-live\">"],
        [cms, '<Text style={dm.clusterText}>{live.length}</Text>'], [cms, "clusterText: { color: color.onInk, fontWeight: '800', fontSize: 10 },"]], { wasOn: 'sheetSignal' }),
      pair(cms, 'crewMap.legend.live', color.signalStrong, color.signal, 'sheetPaperRaised', 'ui', [
        [cms, '<View style={dm.wrap}>'], [cms, /\bwrap: \{\s*backgroundColor: color\.paperRaised,/],
        [cms, '<View style={[dm.dot, { backgroundColor: color.signalStrong }]} />'], [cms, '<Text style={dm.legendText}>Live</Text>']],
        { companion: "the legend's key for the live cluster, whose fill moved for its count; 3.31:1 already" }),
      pair(cms, 'crewMap.shareButton.label', color.signalStrong, color.signal, 'sheetPaperRaised', 'text', [
        [cms, '<View style={s.controlsCard}>'], [cms, /\bcontrolsCard: \{\s*backgroundColor: color\.paperRaised,/], [cms, /\bshareBtn: \{(?:(?!backgroundColor)[^}])*\}/],
        [cms, "shareBtnText: { ...t.small, fontWeight: '800', color: color.signalStrong },"], [cms, '<Text style={s.shareBtnText}>Share location temporarily</Text>']]),
      pair(cms, 'crewMap.visibility.chosen', color.signalStrong, color.signal, 'tripsChipActive', 'text', [
        [cms, "chipActive: { borderColor: color.signal, backgroundColor: '#FFF5F5' },"],
        [cms, "chipLabelActive: { color: color.signalStrong, fontWeight: '800' },"], [cms, '<Text style={[vs.chipLabel, value === opt.value && vs.chipLabelActive]}>{opt.label}</Text>']]),
    ]),
    card(lss, /<LiveShareSheet\b/, [cms], [
      pair(lss, 'liveShare.option.chosen', color.onInk, color.onInk, 'sheetSignalStrong', 'text', [...lssSheet,
        [lss, 'optionActive: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },'], [lss, 'optionTextActive: { color: color.onInk },'],
        [lss, '<Text style={[s.optionText, duration === d.value && s.optionTextActive]}>'], [lss, '<Text style={[s.optionText, visibility === v.value && s.optionTextActive]}>']], { wasOn: 'sheetSignal' }),
      pair(lss, 'liveShare.member.checkMark', color.onInk, color.onInk, 'sheetSignalStrong', 'text', [...lssSheet,
        [lss, 'memberCheckOn: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },'], [lss, "memberCheckMark: { color: color.onInk, fontSize: 12, fontWeight: '700' },"],
        [lss, '{on ? <Text style={s.memberCheckMark}>✓</Text> : null}']], { wasOn: 'sheetSignal' }),
      pair(lss, 'liveShare.member.checkedBox', color.signalStrong, color.signal, 'sheetPaperRaised', 'ui', [...lssSheet,
        [lss, '<View style={[s.memberCheck, on && s.memberCheckOn]}>'], [lss, 'memberCheckOn: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },']],
        { companion: 'the ticked box, 3.31:1 already, is the fill under its ✓, which failed' }),
      pair(lss, 'liveShare.start.label', color.onInk, color.onInk, 'sheetSignalStrong', 'text', [...lssSheet,
        [lss, 'backgroundColor: color.signalStrong, borderRadius: radius.md, paddingVertical: 14, marginTop: space.md,'],
        [lss, "cta: {\n    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,\n    backgroundColor: color.signalStrong,"],
        [lss, 'ctaText: { ...t.bodyStrong, color: color.onInk },'], [lss, '<Text style={s.ctaText}>Start sharing</Text>']], { wasOn: 'sheetSignal' }),
    ]),
    card(ab, /<ArrivalBoard\b/, [cms], [
      // The loading spinner, a state mark. It sits in CrewMapSection's unfilled wrap, so on the trip screen's paper.
      pair(ab, 'arrival.loading', color.mute, color.faint, 'sheetPaper', 'ui', [
        [ab, '<View style={s.loadingWrap}>'], [ab, /\bloadingWrap: \{(?:(?!backgroundColor)[^}])*\}/], [ab, '<ActivityIndicator size="small" color={color.mute} />'],
        [cms, '<ArrivalBoard tripId={tripId} members={members} />'], [cms, 'wrap: { gap: space.md, padding: space.lg },'],
        ['src/components/TripPage.tsx', 'export { CrewMapSection as TripCrewSection }'],
        [TRIP, '<TripCrewSection tripId={trip.id} refreshKey={crewRefreshKey} />'], [TRIP, '<View style={{ flex: 1, backgroundColor: color.paper }}>']], { consumer: cms }),
    ]),
    card(tps, /<TripPlanSection\b/, [TRIP], [
      pair(tps, 'planSection.readOnly.note', color.muteStrong, color.mute, 'sheetHaze', 'text', [
        [tps, '<View style={ps.readOnlyBanner}>'], [tps, /\breadOnlyBanner: \{[^}]*backgroundColor: color\.haze,/],
        [tps, 'readOnlyText:   { ...t.small, color: color.muteStrong, flex: 1 },'], [tps, '<Text style={ps.readOnlyText}>Only the organizer can edit this plan</Text>']]),
      // The Timeline / Map toggle: an unchosen segment paints nothing, so its label sits on the toggle's haze track.
      pair(tps, 'planSection.viewToggle.unchosen', color.muteStrong, color.mute, 'sheetHaze', 'text', [
        [tps, '<View style={vt.wrap}>'], [tps, "wrap:         { flexDirection: 'row', backgroundColor: color.haze, borderRadius: radius.md, padding: 2 },"],
        [tps, "btn:          { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },"],
        [tps, "btnText:      { ...t.small, color: color.muteStrong, fontWeight: '600', fontSize: 11 },"],
        [tps, "<Text style={[vt.btnText, mode === 'timeline' && vt.btnTextActive]}>Timeline</Text>"], [tps, "<Text style={[vt.btnText, mode === 'map' && vt.btnTextActive]}>Map</Text>"]]),
    ]),
  ];
}

test('wave-5 D: every trips-card pair was below its bar before, clears it now, and is anchored in the source', () => {
  const adopters = tripsCardAdopters();
  const pairs = adopters.flatMap((a) => a.pairs);
  assert.ok(adopters.length >= 24 && pairs.length >= 80, `${adopters.length} cards, ${pairs.length} pairs`);
  const problems: string[] = [];
  for (const p of pairs) {
    if (p.kind === 'decor') { problems.push(`${p.id}: decor is never paired here`); continue; }
    if (p.was === undefined) problems.push(`${p.id}: no \`was\` — every pair here records its colour before`);
    const bar = THRESHOLD[p.kind];
    const before = measureRatio(p.was ?? p.fg, adopterGround(p.wasOn ?? p.on));
    const after = measureRatio(p.fg, adopterGround(p.on));
    if (after < bar) problems.push(`${p.id}: ${after.toFixed(2)} < ${bar}`);
    if (after < before - EPS) problems.push(`${p.id}: worse, ${before.toFixed(2)} → ${after.toFixed(2)}`);
    if (p.companion === undefined && before >= bar) problems.push(`${p.id}: was ${before.toFixed(2)} ≥ ${bar}, so it had no reason to move — or declare it a companion and say why`);
    if (p.companion !== undefined && before < bar) problems.push(`${p.id}: a "companion" that itself failed (${before.toFixed(2)}) — it is a fix`);
    for (const [file, needle] of p.at) {
      if (!(typeof needle === 'string' ? source(file).includes(needle) : needle.test(source(file)))) problems.push(`${p.id}: ${file} does not contain ${String(needle)}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length, 'pair ids are unique');
});

test('wave-5 D: print the trips-card table when SHEET_CONTRAST_TABLE=1', () => {
  if (process.env.SHEET_CONTRAST_TABLE !== '1') return;
  const rows = tripsCardAdopters().flatMap((a) => a.pairs).map((p) => {
    const bar = THRESHOLD[p.kind as Exclude<Kind, 'decor'>];
    const before = measureRatio(p.was ?? p.fg, adopterGround(p.wasOn ?? p.on));
    const after = measureRatio(p.fg, adopterGround(p.on));
    return `| ${p.id} | ${p.consumer} | ${p.was ?? p.fg} on ${p.wasOn ?? p.on} | ${before.toFixed(2)} | ${p.fg} on ${p.on} | ${after.toFixed(2)} | ${bar} | ${after >= bar ? 'PASS' : 'FAIL'} | ${p.companion ? 'companion' : 'fix'} |`;
  });
  console.log(['| pair | consumer | before | ratio | after | ratio | bar | result | moved as |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
});

// Independent verification pass 9, C3: a ground the shared lists do not name must be one tripsGrounds() names. A misspelled ground
// on a future pair would otherwise be measured on some default in silence.
test('wave-5 D: an adopter ground the shared lists do not name must be one tripsGrounds() names', () => {
  assert.throws(() => adopterGround('sheetNoSuchGround' as SheetSurface), /no ground named sheetNoSuchGround/);
  assert.deepEqual(adopterGround('sheetPaperRaised'), ALL_SHEET_SURFACES.sheetPaperRaised);
});

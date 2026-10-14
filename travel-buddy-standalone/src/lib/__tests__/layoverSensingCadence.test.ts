/**
 * layoverSensingCadence — census §16 L157 and §17.1 L164, the CLIENT half.
 *
 * ── WHAT THE CENSUS SAYS, AND WHAT IS ACTUALLY WRONG ─────────────────────────
 * L157 ("adaptive sensing: low frequency when safe/stationary, moderate near
 * decision boundaries, navigation-appropriate during RETURNING; avoid
 * continuous GPS") reads `N`, with this evidence: *"The layover surface
 * performs no location sensing at all … The only cadence is a fixed 60-second
 * overview refetch and a 30-second local clock, neither state-dependent."*
 *
 * Both halves of that are re-measured and TRUE at this commit. The prohibition
 * half — avoid continuous GPS — holds by absence, and the last case in this
 * file is what stops that absence being silently reversed (which is also all
 * L164 asks of this surface: location is requested when a traveller enables
 * something that needs it, never merely because Layover exists).
 *
 * The ADAPTIVE half was a real client gap and is what the module closes: the
 * one periodic loop this surface does have re-read the server every 60 seconds
 * whether the traveller had four hours or four minutes.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Every rung is asserted against a NEIGHBOUR, so a policy that answered one
 * constant everywhere fails. `NORMAL` is pinned at exactly the 60 s this screen
 * has always used: this change tightens the cadence as the deadline approaches
 * and must not loosen or quicken the case that was already shipping.
 *
 * And the rule that keeps this honest: the cadence is a function of the
 * CERTIFIED return state alone. It never re-derives the rung from a clock — a
 * second escalation rule on the client is the §13/L115 defect in a new place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LAYOVER_REFRESH_INTERVAL_MS,
  layoverSensingCadence,
} from '../layoverSensingCadence.ts';

test('a session that is not active polls NOTHING', () => {
  const c = layoverSensingCadence({ sessionStatus: 'completed', returnState: 'RETURN_NOW' });
  assert.equal(c.cadence, 'idle');
  assert.equal(c.intervalMs, null);
  // Even at the sharpest rung: an ended layover has nothing left to re-read.
  const cancelled = layoverSensingCadence({ sessionStatus: 'cancelled', returnState: 'NORMAL' });
  assert.equal(cancelled.intervalMs, null);
});

test('NORMAL keeps the 60 s this screen has always used', () => {
  const c = layoverSensingCadence({ sessionStatus: 'active', returnState: 'NORMAL' });
  assert.equal(c.cadence, 'low');
  assert.equal(c.intervalMs, 60_000);
  assert.equal(c.intervalMs, LAYOVER_REFRESH_INTERVAL_MS.low);
});

test('RETURN_SOON is moderate — faster than NORMAL, slower than returning', () => {
  const soon = layoverSensingCadence({ sessionStatus: 'active', returnState: 'RETURN_SOON' });
  const normal = layoverSensingCadence({ sessionStatus: 'active', returnState: 'NORMAL' });
  const now = layoverSensingCadence({ sessionStatus: 'active', returnState: 'RETURN_NOW' });
  assert.equal(soon.cadence, 'moderate');
  assert.ok(soon.intervalMs! < normal.intervalMs!);
  assert.ok(soon.intervalMs! > now.intervalMs!);
});

test('RETURN_NOW and CONNECTION_AT_RISK are the sharpest rung, and are equal', () => {
  const now = layoverSensingCadence({ sessionStatus: 'active', returnState: 'RETURN_NOW' });
  const risk = layoverSensingCadence({ sessionStatus: 'active', returnState: 'CONNECTION_AT_RISK' });
  assert.equal(now.cadence, 'returning');
  assert.equal(risk.cadence, 'returning');
  assert.equal(now.intervalMs, risk.intervalMs);
  assert.equal(now.intervalMs, LAYOVER_REFRESH_INTERVAL_MS.returning);
});

test('an absent or unrecognised return state falls back to the shipping cadence', () => {
  // A server that states no rung does not get one invented for it, and the
  // screen must not go quiet: it keeps the 60 s it always had.
  for (const state of [null, undefined, 'SOMETHING_NEW' as never]) {
    const c = layoverSensingCadence({ sessionStatus: 'active', returnState: state });
    assert.equal(c.intervalMs, 60_000, `state ${String(state)} changed the default`);
    assert.equal(c.cadence, 'low');
  }
});

test('no cadence ever permits continuous location sensing', () => {
  for (const state of ['NORMAL', 'RETURN_SOON', 'RETURN_NOW', 'CONNECTION_AT_RISK'] as const) {
    const c = layoverSensingCadence({ sessionStatus: 'active', returnState: state });
    // This surface has no location grant to spend, in any state, including the
    // emergency one. An emergency does not grant a permission nobody gave.
    assert.equal(c.locationSensing, 'none');
  }
});

/** The files the two prohibition scans below both cover. */
const APP_ROOT = new URL('../../..', import.meta.url).pathname;

/**
 * THE WHOLE layover/airport client scope, DERIVED rather than listed (lead
 * ruling 2026-10-07 on guarded prohibitions: a guard is an artifact only if it
 * covers the full scope). Every non-test `.ts`/`.tsx` under `src/` and `app/`
 * whose path names "layover" or "airport", in any case — so a new layover file
 * anywhere is in scope the day it is created, without editing this list.
 */
function layoverSurfaceFiles(root = APP_ROOT): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        walk(p);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) {
        if (/layover|airport/i.test(relative(root, p))) files.push(p);
      }
    }
  };
  for (const top of ['src', 'app']) walk(join(root, top));
  return files.sort();
}

/** The permission-bearing APIs each prohibition forbids, as import and call patterns. */
const LOCATION_RULES: ReadonlyArray<[RegExp, string]> = [
  [/from ['"]expo-location['"]/, 'imports expo-location'],
  [/requestForegroundPermissionsAsync|requestBackgroundPermissionsAsync|watchPositionAsync|getCurrentPositionAsync/, 'calls a location permission/watch API'],
];
const PHOTO_CONTACT_RULES: ReadonlyArray<[RegExp, string]> = [
  [/from ['"]expo-(image-picker|contacts|camera|media-library)['"]/, 'imports a photo/contacts module'],
  [/launchImageLibraryAsync|launchCameraAsync|getContactsAsync/, 'calls a photo/contacts API'],
];

function permissionOffenders(files: readonly string[], rules: ReadonlyArray<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const [re, what] of rules) if (re.test(src)) out.push(`${f}: ${what}`);
  }
  return out;
}

/**
 * THE SCOPE IS THE IMPORT GRAPH, not the file names (third verification of lane
 * R, F3 on ab67f861bb). A path-named walk missed `src/lib/maps.ts` — which the
 * layover screen imports for L120's directions — and `DiscoveryMapView.tsx`,
 * which `LayoverMapCard` mounts and which L164's own evidence named: a location
 * prompt planted in either passed the guard. The scope is now every file
 * reachable by import from the layover/airport-named files above (relative and
 * `@/` imports, inside `src/` and `app/`, transitively; `node_modules` is not
 * walked), so whatever the layover screen bundles is scanned.
 */
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g; // backtick too (V-712 M13): import(`x`) / require(`x`) load modules as well

/**
 * EVERY file an import can resolve to, not one of them (fourth verification of
 * lane R, F2): Metro resolves `./maps` to `maps.native.ts` / `maps.ios.tsx` /
 * `maps.android.js` on a phone before `maps.ts`, and `.js`/`.jsx` are in its
 * `sourceExts` — the repo's own import-extension lint relies on exactly that
 * (scripts/check-import-extensions.mjs). The phone bundles the sibling, so the
 * guard scans every sibling that exists.
 */
const SOURCE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const; // fifth verification (V-R5 F3): Expo's Metro resolves .mjs (@expo/config extensions.unshift('mjs')) and .cjs (@expo/metro-config sourceExts) too
const PLATFORMS = ['', '.ios', '.android', '.native', '.web'] as const;

function resolveImport(from: string, spec: string, root: string): string[] {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/')) base = join(root, spec.slice(2));
  else return []; // a package: node_modules is not product code
  const candidates = [base];
  for (const stem of [base, join(base, 'index')]) {
    for (const plat of PLATFORMS) for (const ext of SOURCE_EXTS) candidates.push(`${stem}${plat}.${ext}`);
  }
  const out: string[] = [];
  for (const c of candidates) {
    if (!existsSync(c) || !statSync(c).isFile() || !/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(c)) continue;
    const rel = relative(root, c);
    if ((rel.startsWith('src/') || rel.startsWith('app/')) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Every file the layover/airport surface reaches by import, the surface included. */
function layoverImportClosure(root = APP_ROOT): string[] {
  const seen = new Set<string>();
  const stack = [...layoverSurfaceFiles(root)];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT_SPEC)) {
      for (const r of resolveImport(f, m[1]!, root)) if (!seen.has(r)) stack.push(r);
    }
  }
  return [...seen].sort();
}

/**
 * §17.1 L164 — census-layover §70. "Location: request when enabling live return
 * assistance / map context, not solely because Layover exists."
 *
 * THE WHOLE IMPORT GRAPH, AND NO FILE EXCEPTED BY NAME. Until §70 this guard
 * excepted four files — the app-root location provider, its hook, the OS
 * adapter and the place picker — because the graph reached them, and the lead
 * held L164 at `N` for exactly that: the exceptions were where the prompt lived
 * (ruling L164, 2026-10-07). Two changes remove the reason:
 *
 *   - `PlaceDetailSheet` reads the resolved location through
 *     `src/context/locationContextValue.ts`, whose context carries data and no
 *     function and which imports no location hook, so the app-root provider
 *     (`LocationContext.tsx` → `useActiveLocation.ts`) is no longer on the graph;
 *   - the place picker's "Use my current location" row — the one request left
 *     on the graph — asks through `src/lib/location/locationRequestDoor.ts`.
 *
 * What is pinned instead of a name list is a CONDITION per location-capable
 * file, checked mechanically (`locationDoorFindings`, below):
 *
 *   - every file on the graph whose text matches a location rule is one of
 *     LOCATION_DOORS, matching exactly the rules listed for it — both ways;
 *   - `services/location.ts` (the OS prompt) is imported on the graph ONLY by
 *     the door, and its prompting calls sit only inside its GPS function;
 *   - the door is imported only by DOOR_CALLERS, each calls it only inside the
 *     press handler named there, and that handler is referenced only by the
 *     named `<Pressable … onPress>` binding;
 *   - the door's one GPS call comes after its refusal of an unattributed
 *     request;
 *   - the picker touches expo-location only through members that ask nothing;
 *   - the map marker can render the SDK's own location puck (which starts the
 *     platform's location manager — and on iOS its permission request — on
 *     mount) only behind `followDeviceFix`, which defaults to false and which
 *     no other file on the graph names.
 *
 * Rules read raw text, comments included, so a comment naming an API is a
 * finding; that errs toward red, never toward silence. Type-only imports are
 * walked like value imports (the picker is on the graph only through one), so
 * the scan over-approximates what a phone bundles rather than under-.
 */
const LOCATION_REQUEST_RULES: ReadonlyArray<[RegExp, string]> = [
  ...LOCATION_RULES,
  [/\b(?:require|import)\s*\(\s*['"`]expo-location['"`]/, 'loads expo-location dynamically'],
  [/\b(?:useForegroundPermissions|useBackgroundPermissions|getHeadingAsync|watchHeadingAsync|enableNetworkProviderAsync|startLocationUpdatesAsync|startGeofencingAsync|installWebGeolocationPolyfill)\b/, 'calls an expo-location prompt/sensing API'],
  [/\b(?:UserLocation|NativeUserLocation|useCurrentPosition|LocationManager|trackUserLocation|requestAndroidLocationPermissions|showsUserLocation|followsUserLocation|showsMyLocationButton)\b/, "uses a map SDK's own location tracking"],
  [/\bgeolocation\b|\bACCESS_(?:FINE|COARSE|BACKGROUND)_LOCATION\b|['"](?:@react-native-community\/geolocation|react-native-geolocation-service)['"]/, 'uses platform geolocation'],
  [/\b(?:getCurrentGps|requestLocation|refreshLocation|requireLocation)\b/, 'names an app location-request function'],
  [/\bfollowDeviceFix\b/, "turns on the map SDK's location puck"],
];

const OS_ADAPTER = 'src/services/location.ts';
const DOOR = 'src/lib/location/locationRequestDoor.ts';
const DOOR_FN = 'requestLocationForUserAction';
const PICKER = 'src/components/selectors/GlobalPlacePicker.tsx';
const MARKER = 'src/components/map/UserPositionMarker.tsx';

/** Every location-capable file the graph may reach: the rules it matches, exactly, and why that is safe. */
const LOCATION_DOORS: ReadonlyArray<{ file: string; rules: readonly string[]; why: string }> = [
  { file: OS_ADAPTER, rules: ['imports expo-location', 'calls a location permission/watch API', 'names an app location-request function'], why: 'the OS adapter whose GPS function prompts; on this graph only the door imports it' },
  { file: DOOR, rules: ['names an app location-request function'], why: 'the door: refuses an unattributed request, then calls the GPS function once' },
  { file: PICKER, rules: ['imports expo-location'], why: 'reads the EXISTING permission and the last known fix for "Near You" (members that ask nothing); asks only through the door' },
  { file: MARKER, rules: ["uses a map SDK's own location tracking", "turns on the map SDK's location puck"], why: 'renders the SDK puck only behind followDeviceFix, false by default and set by no file on the graph' },
];

/** The ONLY controls that may open the door: each a press handler bound to a Pressable. */
const DOOR_CALLERS: ReadonlyArray<{ file: string; handler: string; binding: string; why: string }> = [
  { file: PICKER, handler: 'useGPS', binding: '<Pressable style={s.row} onPress={useGPS}', why: '"Use my current location": the user asks to place this pick where they are — L164\'s map context' },
];

/** expo-location members the picker may touch: neither asks the user nor starts a fix. */
const SILENT_EXPO_MEMBERS: readonly string[] = ['getForegroundPermissionsAsync', 'getLastKnownPositionAsync'];

/** The app-root location stack. It must not be on the graph at all. */
const APP_ROOT_LOCATION_STACK: readonly string[] = ['src/hooks/useActiveLocation.ts', 'src/context/LocationContext.tsx'];

/** An `import`/`export … from` declaration, possibly over several lines. */
const FROM_DECL = /^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm;

/** `[start, end)` of the body of the `{` that opens at or after `from`, by brace count. */
function braceBody(src: string, from: number): [number, number] | null {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return [open + 1, i];
  }
  return null;
}

function positionsOf(src: string, re: RegExp): number[] {
  return [...src.matchAll(new RegExp(re.source, 'g'))].map((m) => m.index!);
}

/**
 * Every way the layover surface could ask for location other than a press on
 * an enumerated control. Empty is the pass. `root` is a parameter so the same
 * function runs over the real tree and over the planted trees below.
 */
function locationDoorFindings(root = APP_ROOT): string[] {
  const out: string[] = [];
  const closure = layoverImportClosure(root);
  const rel = (f: string) => relative(root, f);
  const read = (r: string) => readFileSync(join(root, r), 'utf8');
  const reached = new Set(closure.map(rel));
  const importers = new Map<string, string[]>();
  for (const f of closure) {
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT_SPEC)) {
      for (const t of resolveImport(f, m[1]!, root)) {
        const list = importers.get(rel(t)) ?? [];
        if (!list.includes(rel(f))) list.push(rel(f));
        importers.set(rel(t), list);
      }
    }
  }
  const importersOf = (r: string) => [...(importers.get(r) ?? [])].sort();

  for (const r of APP_ROOT_LOCATION_STACK) if (reached.has(r)) out.push(`${r}: the app-root location stack is on the layover graph (via ${importersOf(r).join(', ')})`);

  // 1. Every location-capable file is a listed door, matching exactly its listed rules.
  const doors = new Map(LOCATION_DOORS.map((d) => [d.file, d]));
  for (const f of closure) {
    const hits = LOCATION_REQUEST_RULES.filter(([re]) => re.test(readFileSync(f, 'utf8'))).map(([, what]) => what);
    const door = doors.get(rel(f));
    if (!door) { for (const h of hits) out.push(`${rel(f)}: ${h}`); continue; }
    if (JSON.stringify([...hits].sort()) !== JSON.stringify([...door.rules].sort())) out.push(`${rel(f)}: matches [${hits.join('; ')}], listed for [${door.rules.join('; ')}]`);
  }
  for (const d of LOCATION_DOORS) if (!reached.has(d.file)) out.push(`${d.file}: listed as a location door but no longer reached — remove it`);

  // 2. The OS adapter is behind the door, and only its GPS function prompts.
  if (reached.has(OS_ADAPTER)) {
    if (JSON.stringify(importersOf(OS_ADAPTER)) !== JSON.stringify([DOOR])) out.push(`${OS_ADAPTER}: imported on the layover graph by ${importersOf(OS_ADAPTER).join(', ')}, not only by the door`);
    const src = read(OS_ADAPTER);
    const def = src.indexOf('export async function getCurrentGps(');
    const body = def < 0 ? null : braceBody(src, src.indexOf(')', def));
    if (!body) out.push(`${OS_ADAPTER}: the GPS function is not where the door expects it`);
    else {
      if (positionsOf(src, /\bgetCurrentGps\b/).length !== 1) out.push(`${OS_ADAPTER}: the GPS function is named outside its own definition (a call at load would prompt behind no press)`);
      for (const p of positionsOf(src, LOCATION_RULES[1]![0])) if (p < body[0] || p >= body[1]) out.push(`${OS_ADAPTER}: a prompting call outside the GPS function`);
    }
  }

  // 3. The door refuses first, then makes its one call.
  if (reached.has(DOOR)) {
    const src = read(DOOR);
    const def = src.indexOf(`export async function ${DOOR_FN}(`);
    const body = def < 0 ? null : braceBody(src, src.indexOf(')', def));
    const names = positionsOf(src, /\bgetCurrentGps\b/);
    const imports = [...src.matchAll(FROM_DECL)].filter((m) => /\bgetCurrentGps\b/.test(m[0]));
    if (!body) out.push(`${DOOR}: ${DOOR_FN} is not defined as the door's export`);
    else {
      if (!/^\s*if \(!isUserLocationRequest\(request\)\) return \{ \.\.\.NO_USER_ACTION_RESULT \};/.test(src.slice(body[0], body[1]))) out.push(`${DOOR}: ${DOOR_FN} no longer refuses an unattributed request before anything else`);
      const calls = positionsOf(src, /\bgetCurrentGps\s*\(/);
      if (calls.length !== 1 || calls[0]! < body[0] || calls[0]! >= body[1] || names.length !== imports.length + 1) out.push(`${DOOR}: the GPS function is used ${names.length - imports.length} time(s) outside its import; exactly one call, inside ${DOOR_FN}, is allowed`);
    }
  }

  // 4. Only the enumerated controls open the door, and only from their press handlers.
  const callers = new Map(DOOR_CALLERS.map((c) => [c.file, c]));
  if (JSON.stringify(importersOf(DOOR)) !== JSON.stringify([...callers.keys()].filter((f) => reached.has(f)).sort())) out.push(`${DOOR}: imported on the layover graph by [${importersOf(DOOR).join(', ')}], not exactly the enumerated callers`);
  for (const c of DOOR_CALLERS) {
    if (!reached.has(c.file)) continue;
    const src = read(c.file);
    const decls = [...src.matchAll(FROM_DECL)];
    const doorDecls = decls.filter((m) => resolveImport(join(root, c.file), m[1]!, root).some((t) => rel(t) === DOOR));
    for (const m of doorDecls) if (!/^import\s*\{/.test(m[0]) || new RegExp(`\\b${DOOR_FN}\\s+as\\b`).test(m[0])) out.push(`${c.file}: takes the door by namespace, alias or re-export: ${m[0].replace(/\s+/g, ' ')}`);
    const inDecl = (p: number) => decls.some((m) => p >= m.index! && p < m.index! + m[0].length);
    const def = src.indexOf(`function ${c.handler}(`);
    const body = def < 0 ? null : braceBody(src, src.indexOf(')', def));
    if (!body) { out.push(`${c.file}: press handler ${c.handler} not found`); continue; }
    const uses = positionsOf(src, new RegExp(`\\b${DOOR_FN}\\b`)).filter((p) => !inDecl(p));
    if (!uses.some((p) => p >= body[0] && p < body[1])) out.push(`${c.file}: ${c.handler} no longer opens the door — remove the caller`);
    for (const p of uses) if (p < body[0] || p >= body[1]) out.push(`${c.file}: opens the door outside ${c.handler}`);
    const refs = positionsOf(src, new RegExp(`\\b${c.handler}\\b`)).length;
    const bindings = src.split(c.binding).length - 1;
    if (bindings < 1 || refs !== 1 + bindings) out.push(`${c.file}: ${c.handler} is bound ${bindings} time(s) as \`${c.binding}\` and referenced ${refs - 1 - bindings} time(s) besides — it may be reached only by that press`);
  }

  // 5. The picker's own expo-location use asks nothing.
  if (reached.has(PICKER)) {
    const src = read(PICKER);
    const expoDecls = [...src.matchAll(FROM_DECL)].filter((m) => m[1] === 'expo-location');
    const ns = expoDecls.length === 1 ? /^import \* as (\w+) from/.exec(expoDecls[0]![0])?.[1] : undefined;
    if (!ns) out.push(`${PICKER}: expo-location must be taken by exactly one namespace import`);
    else {
      const d = expoDecls[0]!;
      const rest = src.slice(0, d.index!) + src.slice(d.index! + d[0].length);
      for (const m of rest.matchAll(new RegExp(`\\b${ns}\\b(?:\\.(\\w+))?`, 'g'))) {
        if (!m[1] || !SILENT_EXPO_MEMBERS.includes(m[1])) out.push(`${PICKER}: expo-location used as ${m[0]} — only ${SILENT_EXPO_MEMBERS.join(' / ')} ask nothing`);
      }
    }
  }

  // 6. The SDK puck renders only behind followDeviceFix, false by default.
  if (reached.has(MARKER)) {
    const src = read(MARKER);
    const gate = src.indexOf('if (followDeviceFix && UserLocation) {');
    const body = gate < 0 ? null : braceBody(src, gate);
    const renders = positionsOf(src, /<UserLocation\b/);
    if (!/\bfollowDeviceFix = false,/.test(src)) out.push(`${MARKER}: followDeviceFix no longer defaults to false`);
    if (!body || renders.length !== 1 || renders[0]! < body[0] || renders[0]! >= body[1]) out.push(`${MARKER}: the SDK puck renders outside the followDeviceFix gate`);
  }
  return out.sort();
}

test('L164: every location request the layover surface reaches goes through ONE door, opened only by a press — the whole graph, no file excepted by name', () => {
  const findings = locationDoorFindings();
  assert.deepEqual(findings, [], findings.join('\n'));
  const rel = layoverImportClosure().map((f) => relative(APP_ROOT, f));
  assert.ok(rel.length > 100, `only ${rel.length} files scanned — the import walk broke`);
  // The read-only path is the one PlaceDetailSheet takes, and the provider is not on the graph.
  assert.ok(rel.includes('src/context/locationContextValue.ts'), 'the read-only location module is not reached — PlaceDetailSheet reads location some other way');
  for (const f of APP_ROOT_LOCATION_STACK) assert.ok(!rel.includes(f), `${f} is on the layover graph`);
});

/**
 * §17.1 L168 — "photos/contacts not required for core safety operation". Over
 * the WHOLE import closure, with no exception: nothing the layover surface
 * reaches imports a picker, camera, media-library or contacts module or calls
 * one. Avatars render through `CachedImage`, which is display, not access.
 */
test('nothing the layover surface reaches asks for photos or contacts — no exception', () => {
  const files = layoverImportClosure();
  const offenders = permissionOffenders(files, PHOTO_CONTACT_RULES);
  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(files.length > 100, `only ${files.length} files scanned — the import walk broke`);
});

test('the scope is the import graph: the screen, the context, the admin airports screen, the services — and what they import', () => {
  const rel = layoverImportClosure().map((f) => relative(APP_ROOT, f));
  for (const must of [
    'app/layover/[id].tsx', 'src/context/LayoverSessionContext.tsx', 'app/admin/airports.tsx',
    'src/services/layover.ts', 'src/lib/layoverPlanCache.ts', 'src/components/layover/LayoverMapCard.tsx',
    // Not layover-named, reached by import: the two files the path-named walk missed.
    'src/lib/maps.ts', 'src/components/discovery/DiscoveryMapView.tsx',
  ]) assert.ok(rel.includes(must), `${must} is not scanned`);
  assert.ok(!rel.some((f) => /__tests__|\.test\./.test(f)), 'tests are not product code');
});

test('PLANTED violations in the files a PHONE bundles: a .native.ts sibling, a .native.tsx sibling and a .js module', () => {
  const root = mkdtempSync(join(tmpdir(), 'layover-perm-guard-native-'));
  try {
    const plant = (rel: string, body: string) => {
      const dir = join(root, rel.split('/').slice(0, -1).join('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    // Extensionless, as the layover screen imports maps — built by concatenation
    // so the repo's import-extension lint does not read it as this file's import.
    const bare = (p: string) => "'" + p + "'";
    plant('app/layover/[id].tsx', 'import { directionsUrl } from ' + bare('../../src/lib/' + 'maps') + ';\nimport { Map } from ' + bare('../../src/components/discovery/' + 'DiscoveryMapView') + ';\n');
    plant('src/lib/maps.ts', 'import { probe } from ' + bare('./' + 'locProbe') + ';\nexport const directionsUrl = () => probe;\n');
    plant('src/lib/maps.native.ts', "import * as Location from 'expo-location';\nexport const directionsUrl = () => Location.getCurrentPositionAsync();\n");
    plant('src/lib/locProbe.js', "export const probe = () => require('expo-location').requestForegroundPermissionsAsync();\n");
    plant('src/components/discovery/DiscoveryMapView.tsx', 'export const Map = () => null;\n');
    plant('src/components/discovery/DiscoveryMapView.native.tsx', "import * as Contacts from 'expo-contacts';\nexport const Map = () => Contacts.getContactsAsync();\n");
    // A layover-NAMED .js file is a surface root on its own, imported or not.
    plant('src/lib/layoverLegacyShim.js', "export const legacy = () => require('expo-location').watchPositionAsync({}, () => {});\n");
    const files = layoverImportClosure(root).map((f) => relative(root, f));
    for (const must of ['src/lib/maps.native.ts', 'src/lib/locProbe.js', 'src/components/discovery/DiscoveryMapView.native.tsx', 'src/lib/layoverLegacyShim.js']) {
      assert.ok(files.includes(must), `${must} is bundled on a phone and must be scanned: ${files.join(', ')}`);
    }
    const abs = layoverImportClosure(root);
    const loc = permissionOffenders(abs, LOCATION_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(loc.sort(), [
      'src/lib/layoverLegacyShim.js: calls a location permission/watch API',
      'src/lib/locProbe.js: calls a location permission/watch API',
      'src/lib/maps.native.ts: calls a location permission/watch API',
      'src/lib/maps.native.ts: imports expo-location',
    ]);
    const pc = permissionOffenders(abs, PHOTO_CONTACT_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(pc.sort(), [
      'src/components/discovery/DiscoveryMapView.native.tsx: calls a photo/contacts API',
      'src/components/discovery/DiscoveryMapView.native.tsx: imports a photo/contacts module',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PLANTED violations in .mjs and .cjs modules, which Expo\'s Metro also bundles (fifth verification, V-R5 F3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'layover-perm-guard-mjs-'));
  try {
    const plant = (rel: string, body: string) => {
      const dir = join(root, rel.split('/').slice(0, -1).join('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    const bare = (p: string) => "'" + p + "'";
    // Extensionless imports whose ONLY targets are an .mjs and a .cjs file.
    plant('app/layover/[id].tsx', 'import { watch } from ' + bare('../../src/lib/' + 'probeM') + ';\nimport { read } from ' + bare('../../src/lib/' + 'probeC') + ';\n');
    plant('src/lib/probeM.mjs', "import * as Location from 'expo-location';\nexport const watch = () => Location.watchPositionAsync({}, () => {});\n");
    plant('src/lib/probeC.cjs', "const Contacts = require('expo-contacts');\nexports.read = () => Contacts.getContactsAsync();\n");
    // A layover-NAMED .mjs file is a surface root on its own, imported or not.
    plant('src/lib/layoverShim.mjs', "export const shim = () => import('expo-location').then((L) => L.requestForegroundPermissionsAsync());\n");
    const abs = layoverImportClosure(root);
    const files = abs.map((f) => relative(root, f));
    for (const must of ['src/lib/probeM.mjs', 'src/lib/probeC.cjs', 'src/lib/layoverShim.mjs']) {
      assert.ok(files.includes(must), `${must} is bundled on a phone and must be scanned: ${files.join(', ')}`);
    }
    const loc = permissionOffenders(abs, LOCATION_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(loc.sort(), [
      'src/lib/layoverShim.mjs: calls a location permission/watch API',
      'src/lib/probeM.mjs: calls a location permission/watch API',
      'src/lib/probeM.mjs: imports expo-location',
    ]);
    const pc = permissionOffenders(abs, PHOTO_CONTACT_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(pc, ['src/lib/probeC.cjs: calls a photo/contacts API']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PLANTED violations are caught where the path-named walk could not see them: maps.ts and DiscoveryMapView.tsx', () => {
  const root = mkdtempSync(join(tmpdir(), 'layover-perm-guard-'));
  try {
    const plant = (rel: string, body: string) => {
      const dir = join(root, rel.split('/').slice(0, -1).join('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    // Explicit extensions in the planted sources: the repo's import-extension lint reads these strings
    // too. Extensionless resolution is covered by the real tree (app/layover/[id].tsx imports maps that way).
    plant('app/layover/[id].tsx', "import { directionsUrl } from '../../src/lib/maps.ts';\nimport { LayoverMapCard } from '../../src/components/layover/LayoverMapCard.tsx';\n");
    plant('src/components/layover/LayoverMapCard.tsx', "import { DiscoveryMapView } from '@/src/components/discovery/DiscoveryMapView.tsx';\n");
    plant('src/lib/maps.ts', "import * as Location from 'expo-location';\nexport const whereAmI = () => Location.getCurrentPositionAsync();\n");
    plant('src/components/discovery/DiscoveryMapView.tsx', "import * as Contacts from 'expo-contacts';\nexport const read = () => Contacts.getContactsAsync();\n");
    plant('src/components/other/Unrelated.tsx', "import * as Location from 'expo-location';\n");
    const files = layoverImportClosure(root);
    assert.deepEqual(files.map((f) => relative(root, f)), [
      'app/layover/[id].tsx', 'src/components/discovery/DiscoveryMapView.tsx', 'src/components/layover/LayoverMapCard.tsx', 'src/lib/maps.ts',
    ], 'reached by import, and only those: an unimported file is not the layover surface');
    const loc = permissionOffenders(files, LOCATION_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(loc, ['src/lib/maps.ts: imports expo-location', 'src/lib/maps.ts: calls a location permission/watch API']);
    const pc = permissionOffenders(files, PHOTO_CONTACT_RULES).map((x) => x.replace(root + '/', ''));
    assert.deepEqual(pc, ['src/components/discovery/DiscoveryMapView.tsx: imports a photo/contacts module', 'src/components/discovery/DiscoveryMapView.tsx: calls a photo/contacts API']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * §70 — the L164 door guard against PLANTED trees. A baseline tree reproduces
 * the real graph's shape (the layover screen → map card → place sheet → the
 * read-only location module, and → route sheet → picker → door → OS adapter;
 * map → marker) and must yield NO finding — the control. Each case then plants
 * ONE way of asking for location other than a press on an enumerated control,
 * and must yield the finding named for it.
 */
const DOOR_TREE: Readonly<Record<string, string>> = {
  'app/layover/[id].tsx': "import { LayoverMapCard } from '../../src/components/layover/LayoverMapCard.tsx';\n",
  'src/components/layover/LayoverMapCard.tsx': "import { PlaceDetailSheet } from '../discovery/PlaceDetailSheet.tsx';\nimport { DiscoveryMapView } from '../discovery/DiscoveryMapView.tsx';\nexport const LayoverMapCard = () => null;\n",
  'src/components/discovery/PlaceDetailSheet.tsx': "import { useResolvedLocation } from '../../context/locationContextValue.ts';\nimport type { RouteStopDraft } from '../RouteBuilderSheet.tsx';\nexport const PlaceDetailSheet = () => useResolvedLocation();\n",
  'src/context/locationContextValue.ts': 'export const useResolvedLocation = () => null;\n',
  'src/components/RouteBuilderSheet.tsx': "import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';\nexport type RouteStopDraft = { id: string };\n",
  'src/components/selectors/GlobalPlacePicker.tsx': [
    "import * as ExpoLocation from 'expo-location';",
    "import { requestLocationForUserAction, USER_PRESS_MAP_CONTEXT } from '../../lib/location/locationRequestDoor.ts';",
    'export function GlobalPlacePicker() {',
    '  useEffect(() => { void ExpoLocation.getForegroundPermissionsAsync().then(() => ExpoLocation.getLastKnownPositionAsync()); }, []);',
    '  async function useGPS() {',
    '    const gps = await requestLocationForUserAction(USER_PRESS_MAP_CONTEXT);',
    '    return gps;',
    '  }',
    '  return <Pressable style={s.row} onPress={useGPS} />;',
    '}',
    '',
  ].join('\n'),
  'src/lib/location/locationRequestDoor.ts': [
    "import { getCurrentGps } from '../../services/location.ts';",
    'export async function requestLocationForUserAction(request: unknown) {',
    '  if (!isUserLocationRequest(request)) return { ...NO_USER_ACTION_RESULT };',
    '  return getCurrentGps();',
    '}',
    '',
  ].join('\n'),
  'src/services/location.ts': [
    "import * as Location from 'expo-location';",
    'export async function getCurrentGps(): Promise<unknown> {',
    '  const { status } = await Location.requestForegroundPermissionsAsync();',
    "  return status === 'granted' ? Location.getCurrentPositionAsync({}) : null;",
    '}',
    'export async function checkLocationPermission() { return Location.getForegroundPermissionsAsync(); }',
    '',
  ].join('\n'),
  'src/components/discovery/DiscoveryMapView.tsx': "import { UserPositionMarker } from '../map/UserPositionMarker.tsx';\nexport const DiscoveryMapView = () => <UserPositionMarker lat={1} lng={2} />;\n",
  'src/components/map/UserPositionMarker.tsx': [
    "const { Marker, UserLocation } = require('@maplibre/maplibre-react-native');",
    'export function UserPositionMarker({ lat, lng, followDeviceFix = false, }) {',
    '  if (followDeviceFix && UserLocation) {',
    '    return <UserLocation visible />;',
    '  }',
    '  return <Marker lngLat={[lng, lat]} />;',
    '}',
    '',
  ].join('\n'),
};

type DoorPlant = { plant: (rel: string, body: string) => void; edit: (rel: string, from: string, to: string) => void };

function withDoorTree(mutate: (p: DoorPlant) => void): string[] {
  const root = mkdtempSync(join(tmpdir(), 'layover-location-door-'));
  try {
    const plant = (rel: string, body: string) => {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    const edit = (rel: string, from: string, to: string) => {
      const src = readFileSync(join(root, rel), 'utf8');
      assert.ok(src.includes(from), `planting into ${rel}: ${from} is not there`);
      writeFileSync(join(root, rel), src.replace(from, to));
    };
    for (const [rel, body] of Object.entries(DOOR_TREE)) plant(rel, body);
    mutate({ plant, edit });
    return locationDoorFindings(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HOOK = "import { getCurrentGps } from '../services/location.ts';\nexport const useActiveLocation = () => ({ requestLocation: getCurrentGps });\n";
const MAP_CARD = 'src/components/layover/LayoverMapCard.tsx';
const SHEET = 'src/components/discovery/PlaceDetailSheet.tsx';

const DOOR_CASES: ReadonlyArray<{ name: string; mutate: (p: DoorPlant) => void; expect: readonly string[] }> = [
  { name: 'the app-root location hook is imported', expect: [
    'src/hooks/useActiveLocation.ts: the app-root location stack is on the layover graph',
    'src/hooks/useActiveLocation.ts: names an app location-request function',
    `${OS_ADAPTER}: imported on the layover graph by src/hooks/useActiveLocation.ts, ${DOOR}, not only by the door`,
  ], mutate: ({ plant, edit }) => {
    plant('src/hooks/useActiveLocation.ts', HOOK);
    edit(MAP_CARD, 'export const', "import { useActiveLocation } from '../../hooks/useActiveLocation.ts';\nexport const");
  } },
  { name: 'the place sheet reads the PROVIDER again, not the read-only module', expect: [
    'src/context/LocationContext.tsx: the app-root location stack is on the layover graph',
    'src/hooks/useActiveLocation.ts: the app-root location stack is on the layover graph',
  ], mutate: ({ plant, edit }) => {
    plant('src/hooks/useActiveLocation.ts', HOOK);
    plant('src/context/LocationContext.tsx', "import { useActiveLocation } from '../hooks/useActiveLocation.ts';\nexport const useLocationContext = () => useActiveLocation();\n");
    edit(SHEET, "from '../../context/locationContextValue.ts'", "from '../../context/LocationContext.tsx'");
  } },
  { name: 'a request function reached through context', expect: [`${SHEET}: names an app location-request function`],
    mutate: ({ edit }) => edit(SHEET, '=> useResolvedLocation();', '=> useLocationContext().requestLocation();') },
  { name: 'a direct OS prompt on the layover surface', expect: [`${MAP_CARD}: imports expo-location`, `${MAP_CARD}: calls a location permission/watch API`],
    mutate: ({ edit }) => edit(MAP_CARD, 'export const', "import * as Location from 'expo-location';\nexport const ask = () => Location.requestForegroundPermissionsAsync();\nexport const") },
  { name: 'expo-location loaded dynamically and called by a computed name', expect: [`${MAP_CARD}: loads expo-location dynamically`],
    mutate: ({ edit }) => edit(MAP_CARD, 'export const', "const L = require('expo-location');\nexport const ask = () => L['request' + 'ForegroundPermissionsAsync']();\nexport const") },
  { name: 'a background or heading sensor started', expect: [`${MAP_CARD}: calls an expo-location prompt/sensing API`],
    mutate: ({ edit }) => edit(MAP_CARD, 'export const', "export const track = (L: any) => L.startLocationUpdatesAsync('layover-track');\nexport const") },
  { name: 'platform geolocation', expect: [`${MAP_CARD}: uses platform geolocation`],
    mutate: ({ edit }) => edit(MAP_CARD, 'export const', 'export const where = () => navigator.geolocation.getCurrentPosition(() => {});\nexport const') },
  { name: 'the SDK location puck mounted directly', expect: [`${MAP_CARD}: uses a map SDK's own location tracking`],
    mutate: ({ edit }) => edit(MAP_CARD, 'export const', "const { UserLocation } = require('@maplibre/maplibre-react-native');\nexport const Puck = () => <UserLocation visible />;\nexport const") },
  { name: 'the map turns the marker\'s puck on', expect: ["src/components/discovery/DiscoveryMapView.tsx: turns on the map SDK's location puck"],
    mutate: ({ edit }) => edit('src/components/discovery/DiscoveryMapView.tsx', 'lng={2} />', 'lng={2} followDeviceFix />') },
  { name: 'the marker\'s puck defaults ON', expect: [`${MARKER}: followDeviceFix no longer defaults to false`],
    mutate: ({ edit }) => edit(MARKER, 'followDeviceFix = false,', 'followDeviceFix = true,') },
  { name: 'the marker renders the puck outside its gate', expect: [`${MARKER}: the SDK puck renders outside the followDeviceFix gate`],
    mutate: ({ edit }) => edit(MARKER, "  return <Marker lngLat={[lng, lat]} />;", '  return <UserLocation visible />;') },
  { name: 'a NEW door caller', expect: [`${DOOR}: imported on the layover graph by [${MAP_CARD}, ${PICKER}], not exactly the enumerated callers`],
    mutate: ({ edit }) => edit(MAP_CARD, 'export const', "import { requestLocationForUserAction, USER_PRESS_MAP_CONTEXT } from '../../lib/location/locationRequestDoor.ts';\nuseEffect(() => { void requestLocationForUserAction(USER_PRESS_MAP_CONTEXT); }, []);\nexport const") },
  { name: 'the enumerated caller opens the door on mount', expect: [`${PICKER}: opens the door outside useGPS`],
    mutate: ({ edit }) => edit(PICKER, '  async function useGPS() {', '  useEffect(() => { void requestLocationForUserAction(USER_PRESS_MAP_CONTEXT); }, []);\n  async function useGPS() {') },
  { name: 'the press handler is also called from an effect', expect: [`${PICKER}: useGPS is bound 1 time(s) as \`<Pressable style={s.row} onPress={useGPS}\` and referenced 1 time(s) besides`],
    mutate: ({ edit }) => edit(PICKER, '  async function useGPS() {', '  useEffect(() => { void useGPS(); }, []);\n  async function useGPS() {') },
  { name: 'the press handler is bound to something that is not a press', expect: [`${PICKER}: useGPS is bound 0 time(s)`],
    mutate: ({ edit }) => edit(PICKER, 'onPress={useGPS}', 'onLayout={useGPS}') },
  { name: 'the door taken under an alias', expect: [`${PICKER}: takes the door by namespace, alias or re-export`, `${PICKER}: useGPS no longer opens the door`],
    mutate: ({ edit }) => { edit(PICKER, 'import { requestLocationForUserAction,', 'import { requestLocationForUserAction as ask,'); edit(PICKER, 'await requestLocationForUserAction(', 'await ask('); } },
  { name: 'the caller re-exports the door', expect: [`${PICKER}: takes the door by namespace, alias or re-export: export *`],
    mutate: ({ edit }) => edit(PICKER, 'export function GlobalPlacePicker', "export * from '../../lib/location/locationRequestDoor.ts';\nexport function GlobalPlacePicker") },
  { name: 'the picker reads a member that takes a fix', expect: [`${PICKER}: matches [imports expo-location; calls a location permission/watch API], listed for [imports expo-location]`, `${PICKER}: expo-location used as ExpoLocation.getCurrentPositionAsync`],
    mutate: ({ edit }) => edit(PICKER, 'ExpoLocation.getLastKnownPositionAsync()', 'ExpoLocation.getCurrentPositionAsync({})') },
  { name: 'the picker reaches expo-location by a computed name', expect: [`${PICKER}: expo-location used as ExpoLocation —`],
    mutate: ({ edit }) => edit(PICKER, 'ExpoLocation.getLastKnownPositionAsync()', "ExpoLocation['getCurrent' + 'PositionAsync']({})") },
  { name: 'the door stops refusing an unattributed request', expect: [`${DOOR}: requestLocationForUserAction no longer refuses an unattributed request before anything else`],
    mutate: ({ edit }) => edit(DOOR, '  if (!isUserLocationRequest(request)) return { ...NO_USER_ACTION_RESULT };\n', '') },
  { name: 'the door asks at load', expect: [`${DOOR}: the GPS function is used 2 time(s) outside its import`],
    mutate: ({ edit }) => edit(DOOR, 'export async function', 'void getCurrentGps();\nexport async function') },
  { name: 'the door\'s one call moved out of the gated function', expect: [`${DOOR}: the GPS function is used 1 time(s) outside its import`],
    mutate: ({ edit }) => { edit(DOOR, 'export async function', 'const ask = () => getCurrentGps();\nexport async function'); edit(DOOR, '  return getCurrentGps();', '  return ask();'); } },
  { name: 'the door hands the GPS function out as a value', expect: [`${DOOR}: the GPS function is used 2 time(s) outside its import`],
    mutate: ({ edit }) => edit(DOOR, 'export async function', 'export const raw = getCurrentGps;\nexport async function') },
  { name: 'the OS adapter asks at load', expect: [`${OS_ADAPTER}: the GPS function is named outside its own definition`],
    mutate: ({ edit }) => edit(OS_ADAPTER, 'export async function checkLocationPermission', 'void getCurrentGps();\nexport async function checkLocationPermission') },
  { name: 'the OS adapter prompts outside its GPS function', expect: [`${OS_ADAPTER}: a prompting call outside the GPS function`],
    mutate: ({ edit }) => edit(OS_ADAPTER, 'return Location.getForegroundPermissionsAsync(); }', 'return Location.requestForegroundPermissionsAsync(); }') },
  { name: 'a second importer of the OS adapter', expect: [`${OS_ADAPTER}: imported on the layover graph by src/components/RouteBuilderSheet.tsx, ${DOOR}, not only by the door`],
    mutate: ({ edit }) => edit('src/components/RouteBuilderSheet.tsx', 'export type', "import { checkLocationPermission } from '../services/location.ts';\nexport type") },
  { name: 'a listed door that is no longer reached', expect: [
    `${PICKER}: listed as a location door but no longer reached — remove it`,
    `${DOOR}: listed as a location door but no longer reached — remove it`,
    `${OS_ADAPTER}: listed as a location door but no longer reached — remove it`,
  ], mutate: ({ edit }) => edit('src/components/RouteBuilderSheet.tsx', "import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';\n", '') },
];

test('L164 PLANTED: the baseline door tree passes — the control every planted case is measured against', () => {
  assert.deepEqual(withDoorTree(() => {}), []);
});

for (const c of DOOR_CASES) {
  test(`L164 PLANTED: ${c.name} — the door guard goes red`, () => {
    const findings = withDoorTree(c.mutate);
    assert.ok(findings.length > 0, 'no finding: the violation passed the guard');
    for (const e of c.expect) assert.ok(findings.some((f) => f.startsWith(e)), `expected a finding starting "${e}"; got:\n${findings.join('\n')}`);
  });
}

// V-712 M13 (2026-10-14): a template-literal specifier loads a module exactly like a quoted one. Appended at the end of
// the file so no line §70 cites moves.
test('PLANTED: a template-literal import()/require() is walked and its expo-location load is caught (V-712 M13)', () => {
  const root = mkdtempSync(join(tmpdir(), 'layover-perm-guard-tpl-'));
  try {
    const plant = (rel: string, body: string) => {
      mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    plant('app/layover/[id].tsx', 'export const go = () => import(`../../src/lib/probeT`).then((m) => m.p());\n');
    plant('src/lib/probeT.ts', 'export const p = () => import(`expo-location`).then((L) => L.getLastKnownPositionAsync());\n');
    const abs = layoverImportClosure(root);
    const files = abs.map((f) => relative(root, f));
    assert.ok(files.includes('src/lib/probeT.ts'), `a template-literal import must be walked: ${files.join(', ')}`);
    const loc = permissionOffenders(abs, LOCATION_REQUEST_RULES).map((x) => x.replace(root + '/', ''));
    assert.ok(loc.includes('src/lib/probeT.ts: loads expo-location dynamically'), `expected the dynamic load to be caught; got:\n${loc.join('\n')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

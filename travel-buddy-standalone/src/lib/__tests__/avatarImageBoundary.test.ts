/**
 * THE AVATAR NETWORK BOUNDARY, as a guard (lane PRIV-FIX-3; census-telegraph §97).
 *
 * A person's avatar is drawn by every viewer of that person, so an avatar URL a
 * person chose is a URL every viewer's device fetches. The server now keeps
 * `profiles.avatar_url` to the person's own upload (migration 3827), but rows
 * written before keep their value, so the app itself must never hand a
 * non-storage avatar URL to an image loader: `src/lib/avatarImageUri.ts`.
 *
 * WHAT IS SCANNED. Every non-test .ts/.tsx file under app/ and src/, parsed with
 * the TypeScript compiler (not matched as text).
 *
 * THE RULES.
 *   SINK   every image sink — `Image` / `ImageBackground` (react-native), `Image`
 *          (expo-image), and the app's `CachedImage`, `DisplayMediaImage`,
 *          `VideoThumbnail` — whose source expression NAMES an avatar
 *          (/avatar/i) binds it through `avatarImageUri(…)` or
 *          `resolveAvatarUrl(…)` (which returns avatarImageUri), directly or
 *          through a same-file `const` whose initializer does (followed
 *          transitively) — or is a pinned, reviewed site. A pin carries its
 *          reason and the COUNT of identical sites; the list may only shrink, and
 *          a stale pin fails.
 *   DOOR   the avatar primitives and the data doors whose bindings do NOT name an
 *          avatar (so SINK cannot see them) each still apply the rule: `Avatar`,
 *          `AvatarImage`, `TelegraphAvatar`, `resolveAvatarUrl`, the reader-chip
 *          faces, the comment avatar, the search suggestion avatar and the
 *          mention row (REQUIRED_DOORS below). Every avatar primitive call site
 *          (`<Avatar uri=…>`, `<AvatarImage …>`, `<UserAvatarButton …>`, …) is
 *          covered by its primitive.
 *
 * KNOWN LIMIT, stated: SINK keys on the NAME of the bound expression. A sink that
 * binds an avatar under a name that does not say so is invisible to SINK; the
 * ones found when this guard was written (the comment avatar's `uri`, the reader
 * chips' `uri`, the search suggestion's `uri`) are pinned as DOORS instead.
 *
 * SELF-TEST. The first block runs the analyzer over synthetic sources: the raw
 * shapes turn it red, the allowed shapes stay green.
 *
 * Pure TypeScript — no React, no native modules, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..', '..', '..');

const PACKAGE_SINKS: Record<string, Record<string, string>> = {
  'react-native': { Image: 'source', ImageBackground: 'source' },
  'expo-image': { Image: 'source' },
};
/** App primitives that hand their source straight to a loader: module path suffix → export → prop. */
const APP_SINKS: Array<[RegExp, string, string]> = [
  [/(^|\/)CachedImage(\.tsx)?$/, 'CachedImage', 'source'],
  [/(^|\/)DisplayMediaImage(\.tsx)?$/, 'DisplayMediaImage', 'uri'],
  [/(^|\/)VideoThumbnail(\.tsx)?$/, 'VideoThumbnail', 'posterUri'],
];
const DOORS = new Set(['avatarImageUri', 'resolveAvatarUrl']);

export interface Pin { key: string; count: number; why: string }
export interface Finding { file: string; line: number; key: string }

/** Reviewed avatar-named bindings that may stay raw. Shrink-only. */
export const PINS: Pin[] = [
  {
    key: 'app/profile/edit/photos.tsx <Image source={{ uri: avatarSource }}>',
    count: 1,
    why: "the person's OWN photo screen: `avatarUri ?? avatarImageUri(avatarUrl) ?? null` — the left operand is the file just picked on this device (expo-image-picker, never a network URL); the stored avatar goes through the door",
  },
  {
    key: 'src/components/MentionSuggestionList.tsx <CachedImage source={{ uri: item.avatarUrl }}>',
    count: 1,
    why: "EntityRow rebuilds `item` for a user row with avatarUrl: avatarImageUri(rawItem.avatarUrl) (REQUIRED_DOORS); the expression is kept byte-identical because PR #740 (TM-2) pins it in the message-tree guard. Non-user rows (place, trip, event images) are not avatars",
  },
];

/**
 * The doors SINK cannot see by name, and the primitives every `<Avatar …>`-style call site
 * relies on. Each must still contain its door expression (normalised whitespace).
 */
export const REQUIRED_DOORS: Array<{ file: string; must: string; why: string }> = [
  { file: 'src/components/ui/Avatar.tsx', must: 'const uri = avatarImageUri(rawUri);', why: 'the Avatar primitive (every <Avatar uri=…>)' },
  { file: 'src/components/ui/DisplayMediaImage.tsx', must: 'resolveDisplayMedia([avatarImageUri(uri), avatarImageUri(user?.avatarUrl)])', why: 'the AvatarImage primitive (every <AvatarImage …>, UserAvatarButton, components/ui.tsx Avatar)' },
  { file: 'src/components/telegraph/TelegraphPrimitives.tsx', must: 'const uri = avatarImageUri(rawUri);', why: 'TelegraphAvatar' },
  { file: 'src/utils/identity.ts', must: 'return avatarImageUri(url);', why: 'resolveAvatarUrl (PassportHero, PassportIdentityCard, avatarFallback)' },
  { file: 'src/features/telegraph/lifecycle/useReaderAvatars.ts', must: 'avatarImageUri(readerFace(userId))', why: "reader chips: GroupChatScreen binds them to a raw <Image source={{ uri }}>" },
  { file: 'src/components/CommentsSheet.tsx', must: 'const uri = avatarImageUri(rawUri);', why: 'CommentAvatar binds `uri` to a raw <Image>' },
  { file: 'src/components/search/SearchSuggestionsPanel.tsx', must: 'avatarImageUri(item.avatarUrl)', why: "SuggestionAvatar binds `uri` to DisplayMediaImage" },
  { file: 'src/components/MentionSuggestionList.tsx', must: 'avatarUrl: avatarImageUri(rawItem.avatarUrl)', why: "EntityRow rebuilds a user's row before its image binds item.avatarUrl" },
];

// ── the analyzer ─────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function sinkProp(tag: ts.JsxTagNameExpression, imports: Map<string, { module: string; name: string }>): string | null {
  if (!ts.isIdentifier(tag)) return null;
  const imp = imports.get(tag.text);
  if (!imp) return null;
  const pkg = PACKAGE_SINKS[imp.module]?.[imp.name];
  if (pkg) return pkg;
  for (const [re, name, prop] of APP_SINKS) if (re.test(imp.module) && imp.name === name) return prop;
  return null;
}

function importsOf(sf: ts.SourceFile): Map<string, { module: string; name: string }> {
  const map = new Map<string, { module: string; name: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const module = st.moduleSpecifier.text;
    const c = st.importClause;
    if (c.name) map.set(c.name.text, { module, name: 'default' });
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
      for (const el of c.namedBindings.elements) map.set(el.name.text, { module, name: (el.propertyName ?? el.name).text });
    }
  }
  return map;
}

/** Every `const <name> = <init>` in the file (all of them: a shadowing declaration must also comply). */
function constInits(sf: ts.SourceFile): Map<string, ts.Expression[]> {
  const out = new Map<string, ts.Expression[]>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const list = n.parent;
      if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0) {
        out.set(n.name.text, [...(out.get(n.name.text) ?? []), n.initializer]);
      } else out.set(n.name.text, [...(out.get(n.name.text) ?? []), ts.factory.createIdentifier('__not_const__')]);
    }
    if ((ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) {
      out.set(n.name.text, [...(out.get(n.name.text) ?? []), ts.factory.createIdentifier('__binding__')]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}


/** Parentheses, `as`, `!` and `satisfies` change no value. */
function strip(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x;
}

/** The identifier an expression is rooted in (`a.b?.c` → a), or null. */
function rootIdent(e: ts.Expression): string | null {
  let x: ts.Expression = strip(e);
  while (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = strip(x.expression);
  return ts.isIdentifier(x) ? x.text : null;
}

/**
 * STRUCTURAL: the value can only be a door's answer (or nothing). A door call anywhere inside
 * is not enough — `raw ?? avatarImageUri(x)` still binds `raw`. Followed: `??` `||` `&&` (every
 * value operand), `c ? a : b` (both arms), `map[key]` (a hydration map read with a door value as
 * its key — the signed or cached copy of that same reference), null / undefined / '', and a
 * same-file `const` whose every declaration is itself compliant.
 */
function compliant(e0: ts.Expression, consts: Map<string, ts.Expression[]>, seen = new Set<string>()): boolean {
  const e = strip(e0);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && DOORS.has(e.expression.text)) return true;
  if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return true;
  if (ts.isStringLiteral(e) && e.text === '') return true;
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
    return compliant(e.left, consts, seen) && compliant(e.right, consts, seen);
  }
  if (ts.isConditionalExpression(e)) return compliant(e.whenTrue, consts, seen) && compliant(e.whenFalse, consts, seen);
  if (ts.isElementAccessExpression(e)) return compliant(e.argumentExpression, consts, seen);
  const root = rootIdent(e);
  if (!root || seen.has(root)) return false;
  const inits = consts.get(root);
  if (!inits || inits.length === 0) return false;
  const next = new Set(seen); next.add(root);
  return inits.every((i) => !(ts.isIdentifier(i) && (i.text === '__not_const__' || i.text === '__binding__')) && compliant(i, consts, next));
}

/** The expression a sink binds: `source={{ uri: X }}` → X; `uri={X}` → X. */
function boundExpr(attr: ts.JsxAttribute): ts.Expression | null {
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  const e = init.expression;
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'uri') return p.initializer;
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'uri') return p.name;
    }
    return e;
  }
  return e;
}

export function analyze(rel: string, text: string): { findings: Finding[]; sinks: number; avatarSinks: number } {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = importsOf(sf);
  const consts = constInits(sf);
  const findings: Finding[] = [];
  let sinks = 0;
  let avatarSinks = 0;
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const prop = sinkProp(n.tagName, imports);
      if (prop) {
        for (const a of n.attributes.properties) {
          if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== prop) continue;
          sinks++;
          const e = boundExpr(a);
          if (!e) continue;
          const exprText = norm(e.getText(sf));
          if (!/avatar/i.test(exprText)) continue;
          avatarSinks++;
          if (compliant(e, consts)) continue;
          findings.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            key: `${rel} <${n.tagName.getText(sf)} ${prop}=${norm(a.initializer!.getText(sf))}>`,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { findings, sinks, avatarSinks };
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === '__fixtures__') continue;
      yield* walk(p);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

// ── self-test ────────────────────────────────────────────────────────────────

test('SELF-TEST: raw avatar bindings are findings; the doors and a const from a door are not', () => {
  const head = "import { Image } from 'react-native';\nimport { Image as ExpoImage } from 'expo-image';\nimport { CachedImage } from './CachedImage.tsx';\nimport { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';\n";
  const red = [
    '<Image source={{ uri: user.avatarUrl }} />',
    '<ExpoImage source={{ uri: p.avatar_url }} />',
    '<CachedImage source={{ uri: avatarUrl }} />',
    '<DisplayMediaImage uri={item.authorAvatar} />',
    '<CachedImage source={{ uri: hostAvatarUrl as string }} />',
  ];
  for (const jsx of red) {
    const r = analyze('src/x.tsx', `${head}export const X = () => ${jsx};\n`);
    assert.equal(r.findings.length, 1, `not caught: ${jsx}`);
  }
  // a door call beside a raw operand is not a door
  assert.equal(analyze('src/x.tsx', `${head}export const X = ({ rawAvatar }: any) => <Image source={{ uri: rawAvatar ?? avatarImageUri(u) }} />;\n`).findings.length, 1);
  // a let, or a parameter, named like an avatar is not a door
  assert.equal(analyze('src/x.tsx', `${head}let a = avatarImageUri(u); a = u; export const X = () => <Image source={{ uri: a.avatar }} />;\n`).findings.length, 1);
  assert.equal(analyze('src/x.tsx', `${head}export const X = ({ avatar }: any) => <Image source={{ uri: avatar }} />;\n`).findings.length, 1);
  const green = [
    'const X = () => <Image source={{ uri: avatarImageUri(user.avatarUrl) ?? undefined }} />;',
    'const X = () => <CachedImage source={{ uri: resolveAvatarUrl(p.avatarUrl) ?? undefined }} />;',
    'const X = (p: any) => { const avatarSrc = avatarImageUri(p.avatarUrl); return <CachedImage source={{ uri: avatarSrc ?? undefined }} />; };',
    'const X = (p: any) => { const safe = avatarImageUri(p.avatarUrl); const hydratedAvatar = safe ?? null; return <Image source={{ uri: hydratedAvatar as string }} />; };',
    'const X = (p: any) => { const safeAvatarUrl = avatarImageUri(p.a); const { resolved } = p; const hydratedAvatarUrl = (safeAvatarUrl && resolved[safeAvatarUrl]) ?? safeAvatarUrl; return <Image source={{ uri: hydratedAvatarUrl as string }} />; };',
    'const X = () => <Image source={{ uri: photoUrl }} />;',
  ];
  for (const g of green) {
    const r = analyze('src/x.tsx', `${head}export ${g}\n`);
    assert.deepEqual(r.findings, [], `false positive: ${g}`);
  }
  // an image imported from somewhere else is not a sink this guard knows
  assert.equal(analyze('src/x.tsx', "import { Image } from './MyImage';\nexport const X = () => <Image source={{ uri: avatarUrl }} />;\n").findings.length, 0);
});

// ── the tree ─────────────────────────────────────────────────────────────────

test('SINK: every image sink in app/ and src/ that binds an avatar goes through avatarImageUri (or a pinned, reviewed site)', () => {
  const findings: Finding[] = [];
  let files = 0;
  let sinks = 0;
  let avatarSinks = 0;
  for (const root of ['app', 'src']) {
    for (const p of walk(join(APP_ROOT, root))) {
      files++;
      const rel = relative(APP_ROOT, p).split('\\').join('/');
      const r = analyze(rel, readFileSync(p, 'utf8'));
      findings.push(...r.findings);
      sinks += r.sinks;
      avatarSinks += r.avatarSinks;
    }
  }
  assert.ok(files > 800, `only ${files} files scanned: the roots moved`);
  assert.ok(sinks > 150, `only ${sinks} image sinks found: the sink map stopped matching`);
  assert.ok(avatarSinks >= 15, `only ${avatarSinks} avatar-named sinks found: the name test went blind`);
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
  const unpinned: string[] = [];
  for (const [key, n] of counts) {
    const pin = PINS.find((p) => p.key === key);
    if (!pin || n > pin.count) unpinned.push(`${key} ×${n}${pin ? ` (pinned ×${pin.count})` : ''}`);
  }
  assert.deepEqual(unpinned, [], 'an image sink binds an avatar URL without avatarImageUri — a viewer\'s device would fetch whatever host the person chose');
  const stale = PINS.filter((p) => (counts.get(p.key) ?? 0) < p.count).map((p) => p.key);
  assert.deepEqual(stale, [], 'a pin no longer matches as many sites as it allows — shrink it');
});

test('DOOR: the avatar primitives and the name-hidden doors still apply the rule', () => {
  const missing: string[] = [];
  for (const d of REQUIRED_DOORS) {
    const text = norm(readFileSync(join(APP_ROOT, d.file), 'utf8'));
    if (!text.includes(norm(d.must))) missing.push(`${d.file}: ${d.must} (${d.why})`);
  }
  assert.deepEqual(missing, []);
});

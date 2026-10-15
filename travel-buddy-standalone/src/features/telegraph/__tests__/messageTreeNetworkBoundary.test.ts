/**
 * census-telegraph T446 (§30A.20) — THE MESSAGE TREE'S NETWORK BOUNDARY, as a
 * guard (B58 TM-2; the provenance-aware ratchet §12 of the census could not
 * draw while sender URLs had no legitimate route, census-telegraph.md:3906-3918).
 *
 *   "External previews cannot cause recipient-side network disclosure to
 *    arbitrary sender-controlled domains." (TG:653)
 *
 * WHAT IS SCANNED. The import closure — within `src/components/` and
 * `src/features/telegraph/` — of every surface that draws a message:
 * the thread screen (`app/messages/[id].tsx`: direct and group threads), the
 * trip/circle chat (`components/GroupChatScreen.tsx`, `app/trip/chat.tsx`), the
 * inbox (`components/TelegraphInboxScreen.tsx`), saved messages
 * (`app/messages/saved.tsx`) and search (`TelegraphSearchScreen.tsx`).
 * Parsed with the TypeScript compiler, not matched as text.
 *
 * THE RULES (each line a way a link in a message could make a recipient's
 * device contact the linked site, or any host a sender picked):
 *   FETCH   every `fetch(` names the Portava API base — a template literal that
 *           starts with `${apiBase()}` (or `${API_BASE…}`), defined in that file
 *           from `EXPO_PUBLIC_API_BASE_URL` — or is a pinned, reviewed exception.
 *           Re-authorization through OUR API (T339 / T411's share projections)
 *           is allowed by construction; a URL from a message is not.
 *   SOCKET  no `new WebSocket` / `XMLHttpRequest` / `EventSource`.
 *   LOAD    no `prefetch`, `getSize`, `getSizeWithHeaders`, `queryCache`,
 *           `loadAsync`, `downloadAsync`, `createDownloadResumable`, and no
 *           `createAsync` except the pinned voice player (a tap plays it).
 *   WEBVIEW no `react-native-webview`, no `<WebView>`.
 *   OPEN    `Linking.openURL` / `openBrowserAsync` / `openAuthSessionAsync` run
 *           only inside a press handler (an `on…Press` attribute or property,
 *           or a function bound to one) — never from render, an effect or a timer.
 *   IMAGE   every image sink — `Image` / `ImageBackground` (react-native),
 *           `Image` (expo-image), `Video` (expo-av), and the app's primitives
 *           `DisplayMediaImage`, `AvatarImage`, `Avatar`, `CachedImage`,
 *           `VideoThumbnail`, `TelegraphAvatar` — binds its source through
 *           `telegraphMediaUri(…)` (Portava storage or nothing), a `require()`
 *           asset, or is a pinned, reviewed site that is NOT message-derived
 *           (a profile avatar, the sender's own local file, a primitive binding
 *           its caller's already-checked prop). A spread onto a sink is a finding.
 *
 * A pin carries the reason and the COUNT of identical sites: the list may only
 * shrink. A pin that no longer matches anything is stale and fails too.
 *
 * SELF-TEST. The first block runs the same analyzer over synthetic sources —
 * the mutants the plan names (a direct `fetch(url)`, `<Image source={{ uri:
 * rawUrl }}>`, `Image.prefetch`, a `WebView`, `openURL` in an effect) each
 * turn it red, and the allowed forms stay green.
 *
 * Pure TypeScript — no React, no native modules, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..', '..', '..', '..');

export const ROOTS = [
  'app/messages/[id].tsx',
  'src/components/GroupChatScreen.tsx',
  'app/trip/chat.tsx',
  'src/components/TelegraphInboxScreen.tsx',
  'app/messages/saved.tsx',
  'src/features/telegraph/components/TelegraphSearchScreen.tsx',
  // Fix round 1 (verifier F1): mounted at the app root, outside every list, it plays what a bubble's tap hands it.
  'src/features/telegraph/media/CompactPlaybackHost.tsx',
];
const inScope = (rel: string) =>
  (rel.startsWith('src/components/') || rel.startsWith('src/features/telegraph/') || ROOTS.includes(rel)) &&
  !rel.includes('/__tests__/') && !/\.test\.tsx?$/.test(rel);

/** The image sinks the app defines: file → exported component → the props that carry a source. */
const SINK_COMPONENTS: Record<string, Record<string, string[]>> = {
  'src/components/ui/DisplayMediaImage.tsx': { DisplayMediaImage: ['uri'], AvatarImage: ['uri', 'user'] },
  'src/components/ui/Avatar.tsx': { Avatar: ['uri'] },
  'src/components/CachedImage.tsx': { CachedImage: ['source'] },
  'src/components/ui/VideoThumbnail.tsx': { VideoThumbnail: ['posterUri'] },
  'src/components/telegraph/TelegraphPrimitives.tsx': { TelegraphAvatar: ['uri'] },
  'src/components/ui/SharedVideoPlayer.tsx': { SharedVideoPlayer: ['uri', 'poster'] },
  'src/components/ui/VideoBlurBackdrop.tsx': { VideoBlurBackdrop: ['uri'] },
};
const PACKAGE_SINKS: Record<string, Record<string, string[]>> = {
  'react-native': { Image: ['source'], ImageBackground: ['source'] },
  'expo-image': { Image: ['source', 'placeholder'], ImageBackground: ['source', 'placeholder'] },
  'expo-av': { Video: ['source', 'posterSource'] },
  // Not used in the tree today; modelled so the guard does not go quiet when one arrives (verifier S2).
  'react-native-svg': { SvgUri: ['uri'], Image: ['href', 'xlinkHref'] },
  'react-native-maps': { Marker: ['image', 'icon'], Overlay: ['image'] },
  'react-native-fast-image': { default: ['source'] },
};
/** `<Animated.Image>` and its kin, reached through a named import of `Animated` (verifier S2). */
const MEMBER_SINKS: Record<string, Record<string, Record<string, string[]>>> = {
  'react-native': { Animated: { Image: ['source'], ImageBackground: ['source'] } },
};
const LOADERS = new Set(['prefetch', 'getSize', 'getSizeWithHeaders', 'queryCache', 'loadAsync', 'downloadAsync', 'createDownloadResumable', 'createAsync',
  // verifier S2: expo-video's player loads its source on creation; expo-file-system/next downloads; a warmed browser session preloads.
  'useVideoPlayer', 'createVideoPlayer', 'downloadFileAsync', 'mayInitWithUrlAsync', 'warmUpAsync']);
const OPENERS = new Set(['openURL', 'openBrowserAsync', 'openAuthSessionAsync']);
const EFFECTS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useFocusEffect', 'useMemo', 'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame', 'runAfterInteractions', 'addEventListener', 'queueMicrotask']);
const PRESS_NAME = /^on\w*Press$/;

export interface Pin { key: string; count: number; why: string }
export interface Finding { file: string; line: number; rule: 'FETCH' | 'SOCKET' | 'LOAD' | 'WEBVIEW' | 'OPEN' | 'IMAGE'; key: string }

// ── the reviewed exceptions ──────────────────────────────────────────────────
// Every pin is a site that is NOT derived from a message. Each says why.

const AVATAR = 'a person’s profile avatar served by our API — not a message field (plan §6 adjacent finding: whether avatar_url writes are storage-validated is a separate follow-up)';
const PRIMITIVE = 'the image primitive itself: binds the source its caller passed, after hydration; every caller in this closure is checked here';
const LOCAL = 'the sender’s own picked file on this device, before upload — never a network URL';

export const IMAGE_PINS: Pin[] = [
  // the primitives themselves
  { key: 'src/components/ui/DisplayMediaImage.tsx <ExpoImage source={resolvedSource}>', count: 2, why: PRIMITIVE },
  { key: 'src/components/ui/DisplayMediaImage.tsx <ExpoImage placeholder={blurhash ? { blurhash } : undefined}>', count: 1, why: 'a blurhash string drawn locally while loading — never a URL' },
  { key: 'src/components/ui/Avatar.tsx <ExpoImage source={source}>', count: 1, why: PRIMITIVE },
  { key: 'src/components/CachedImage.tsx <ExpoImage source={resolvedSource}>', count: 1, why: PRIMITIVE },
  { key: 'src/components/CachedImage.tsx <ExpoImage placeholder={placeholder ? { blurhash: placeholder } : undefined}>', count: 1, why: 'a blurhash string drawn locally while loading — never a URL' },
  { key: 'src/components/ui/VideoThumbnail.tsx <Image source={{ uri: effectivePosterUri }}>', count: 1, why: PRIMITIVE },
  { key: 'src/components/telegraph/TelegraphPrimitives.tsx <Image source={{ uri: effectiveUri }}>', count: 1, why: PRIMITIVE },
  // The root playback host's player (fix round 1, verifier F1): the host hands it telegraphMediaUri(session.mediaRef/posterRef),
  // and the store admits a session only through telegraphMediaUri (compactPlaybackStore.ts#openMessageVideo).
  { key: 'src/components/ui/SharedVideoPlayer.tsx <Video source={{ uri: playbackUri }}>', count: 1, why: PRIMITIVE },
  { key: 'src/components/ui/SharedVideoPlayer.tsx <DisplayMediaImage uri={posterUri}>', count: 1, why: PRIMITIVE },
  { key: 'src/components/ui/SharedVideoPlayer.tsx <VideoBlurBackdrop uri={posterUri}>', count: 1, why: PRIMITIVE },
  { key: 'src/components/ui/VideoBlurBackdrop.tsx <Image source={{ uri }}>', count: 1, why: PRIMITIVE },
  // profile avatars and names (not message-derived)
  { key: 'app/messages/[id].tsx <Avatar uri={creator?.avatarUrl}>', count: 1, why: `${AVATAR} (a meetup creator, GET /meetups/:id)` },
  { key: 'app/messages/[id].tsx <Avatar uri={attendee.avatarUrl}>', count: 1, why: `${AVATAR} (meetup attendees)` },
  { key: 'app/messages/[id].tsx <Avatar uri={uri}>', count: 1, why: `${AVATAR} (readers of the viewer’s own message, useReaderAvatars)` },
  { key: 'app/messages/[id].tsx <Avatar uri={dmProfile?.avatarUrl}>', count: 1, why: `${AVATAR} (the direct thread’s header)` },
  { key: 'src/components/GroupChatScreen.tsx <Image source={{ uri }}>', count: 1, why: `${AVATAR} (readers of the viewer’s own message)` },
  { key: 'src/components/GroupChatScreen.tsx <AvatarImage uri={m.senderAvatarUrl}>', count: 1, why: `${AVATAR} (the sender’s profile, joined by the server)` },
  { key: 'src/components/GroupChatScreen.tsx <AvatarImage user={{ name: m.senderName ?? undefined, handle: m.senderHandle ?? undefined }}>', count: 1, why: 'a name and a handle — this object carries no URL' },
  { key: 'src/components/GroupChatScreen.tsx <AvatarImage uri={m.avatarUrl}>', count: 1, why: `${AVATAR} (the header’s member stack, GET trip/circle members)` },
  { key: 'src/components/GroupChatScreen.tsx <AvatarImage user={{ name: m.name ?? undefined, handle: m.handle ?? undefined }}>', count: 1, why: 'a name and a handle — this object carries no URL' },
  { key: 'src/components/MeetupCreationSheet.tsx <Avatar uri={user.avatarUrl}>', count: 1, why: `${AVATAR} (invitees)` },
  { key: 'src/components/MentionSuggestionList.tsx <CachedImage source={{ uri: item.avatarUrl }}>', count: 1, why: `${AVATAR} (mention suggestions)` },
  { key: 'src/components/TagPreviewSheet.tsx <Avatar uri={data.avatarUrl}>', count: 1, why: `${AVATAR} (a tagged profile’s preview)` },
  { key: 'src/components/TripMembersSheet.tsx <Avatar uri={user.avatarUrl}>', count: 1, why: `${AVATAR} (trip members)` },
  { key: 'src/components/EngagementUserListSheet.tsx <Avatar uri={user.avatarUrl}>', count: 1, why: `${AVATAR} (who stamped a highlight)` },
  { key: 'src/components/HighlightViewersSheet.tsx <Avatar uri={v.avatarUrl}>', count: 1, why: `${AVATAR} (who viewed a highlight)` },
  { key: 'src/components/TelegraphInboxScreen.tsx <Avatar uri={other?.avatarUrl}>', count: 1, why: `${AVATAR} (an inbox row’s other person)` },
  { key: 'src/components/TelegraphInboxScreen.tsx <Avatar uri={sender?.avatarUrl}>', count: 1, why: `${AVATAR} (a message request’s sender)` },
  { key: 'src/components/HighlightViewer.tsx <AvatarImage uri={current.author.avatarUrl}>', count: 1, why: `${AVATAR} (a highlight’s author)` },
  { key: 'src/components/HighlightViewer.tsx <AvatarImage user={current.author}>', count: 1, why: `${AVATAR} (the same author object)` },
  // not message content
  { key: 'src/components/HighlightViewer.tsx <DisplayMediaImage uri={current.mediaUrl}>', count: 1, why: 'a highlight’s own photo (server storage), opened from the inbox’s highlight ring — not a message' },
  { key: 'src/components/HighlightViewer.tsx <Video source={{ uri: playbackUri }}>', count: 1, why: 'a highlight’s own video (server storage, hydrated), opened from the inbox’s highlight ring — not a message' },
  { key: 'src/components/CompassTelegraphTray.tsx <CachedImage source={{ uri: card.imageUrl }}>', count: 1, why: 'the viewer’s OWN Compass tray before anything is shared (GET /compass/telegraph); a shared compass card draws no image' },
  { key: 'src/components/ui/MediaAttachmentTray.tsx <Image source={{ uri: item.uri }}>', count: 1, why: LOCAL },
  { key: 'src/components/ui/VideoStoryTrimSheet.tsx <Video source={{ uri }}>', count: 1, why: LOCAL },
];

export const FETCH_PINS: Pin[] = [
  { key: 'src/features/telegraph/voice/voiceApi.ts fetch(localUri)', count: 1, why: 'reads the sender’s own recording from a local file:// URI to upload it — never a message URL' },
];

export const LOAD_PINS: Pin[] = [
  { key: 'src/features/telegraph/voice/VoiceMessagePlayer.tsx Audio.Sound.createAsync({ uri }, { shouldPlay: false })', count: 1, why: 'loads a voice note only when the listener presses play (ensureSound is reached from the play handler); its url is a storage path routes/telegraphVoice.ts refuses otherwise' },
  { key: 'src/features/telegraph/voice/VoiceRecorderSheet.tsx Audio.Recording.createAsync({ ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true, })', count: 1, why: 'starts a microphone recording on this device — no URL at all' },
];

// ── the analyzer ─────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const PLATFORMS = ['', '.native', '.ios', '.android', '.web'];
function candidates(base: string): string[] {
  const out = [base];
  for (const p of PLATFORMS) out.push(`${base}${p}.ts`, `${base}${p}.tsx`, `${base}/index${p}.ts`, `${base}/index${p}.tsx`);
  return out;
}
/** The module a specifier names (its plain file first). */
function resolveRel(fromRel: string, spec: string, exists: (rel: string) => boolean): string | null {
  return resolveAll(fromRel, spec, exists)[0] ?? null;
}
/** EVERY file the bundler may pick for a specifier — `.native`/`.ios`/`.android`/`.web` variants too (verifier S2/P16). */
function resolveAll(fromRel: string, spec: string, exists: (rel: string) => boolean): string[] {
  if (!spec.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  return candidates(base).filter((c) => exists(c));
}

function moduleSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0]) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface Source { read: (rel: string) => string; exists: (rel: string) => boolean }

export function closureOf(roots: string[], src: Source, scope: (rel: string) => boolean = inScope): string[] {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const rel = stack.pop()!;
    if (seen.has(rel) || !src.exists(rel)) continue;
    seen.add(rel);
    const sf = ts.createSourceFile(rel, src.read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const spec of moduleSpecifiers(sf)) {
      for (const r of resolveAll(rel, spec, src.exists)) if (scope(r)) stack.push(r);
    }
  }
  return [...seen].sort();
}

type Imported = { module: string; resolved: string | null; name: string } | { module: string; resolved: string | null; ns: true };

function importsOf(rel: string, sf: ts.SourceFile, exists: (rel: string) => boolean): Map<string, Imported> {
  const map = new Map<string, Imported>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const module = st.moduleSpecifier.text;
    const resolved = resolveRel(rel, module, exists);
    const c = st.importClause;
    if (c.name) map.set(c.name.text, { module, resolved, name: 'default' });
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) map.set(c.namedBindings.name.text, { module, resolved, ns: true });
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
      for (const el of c.namedBindings.elements) map.set(el.name.text, { module, resolved, name: (el.propertyName ?? el.name).text });
    }
  }
  return map;
}

function sinkPropsFor(tag: ts.JsxTagNameExpression, imports: Map<string, Imported>, rel: string): string[] | null {
  let local: string; let member: string | null = null;
  if (ts.isIdentifier(tag)) local = tag.text;
  else if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) { local = tag.expression.text; member = tag.name.text; }
  else return null;
  const imp = imports.get(local);
  const fromModule = (module: string, resolved: string | null, name: string): string[] | null => {
    if (PACKAGE_SINKS[module]?.[name]) return PACKAGE_SINKS[module][name];
    if (resolved && SINK_COMPONENTS[resolved]?.[name]) return SINK_COMPONENTS[resolved][name];
    return null;
  };
  if (imp) {
    if ('ns' in imp) return member ? fromModule(imp.module, imp.resolved, member) : null;
    if (member) return MEMBER_SINKS[imp.module]?.[imp.name]?.[member] ?? null;
    return fromModule(imp.module, imp.resolved, imp.name);
  }
  // A sink used inside the file that defines it (AvatarImage inside DisplayMediaImage.tsx, …).
  return member === null && SINK_COMPONENTS[rel]?.[local] ? SINK_COMPONENTS[rel][local] : null;
}

/** Exactly `telegraphMediaUri(<one argument>)` — no second argument, no spread (verifier S1). */
function isMediaUriCall(e: ts.Expression): boolean {
  e = skipParens(e);
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'telegraphMediaUri' &&
    e.arguments.length === 1 && !ts.isSpreadElement(e.arguments[0]);
}
function skipParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}
/** A fallback that names no host: `undefined`, `null`, or the empty string. */
function isEmptyFallback(e: ts.Expression): boolean {
  e = skipParens(e);
  return (ts.isIdentifier(e) && e.text === 'undefined') || e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isStringLiteral(e) && e.text === '') || (ts.isNoSubstitutionTemplateLiteral(e) && e.text === '');
}
/**
 * The WHOLE bound expression carries provenance (verifier S1 — a substring test let
 * `raw ?? telegraphMediaUri(x)` and `{ uri: raw, cacheKey: telegraphMediaUri(x) }` through):
 *   telegraphMediaUri(x)                      the call itself
 *   telegraphMediaUri(x) ?? undefined|null|'' the call with an empty fallback
 *   name                                      a const assigned from exactly the above
 *   { uri: <any of the above> }               an image-source object whose ONLY property is that
 *   require('…')                              a bundled asset
 *   '…'                                       a string literal that is not a URL
 */
function isProvenanced(expr: ts.Expression, sf: ts.SourceFile): boolean {
  const e = skipParens(expr);
  if (isMediaUriCall(e)) return true;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && isMediaUriCall(e.left) && isEmptyFallback(e.right)) return true;
  if (ts.isIdentifier(e) && constFromMediaUri(sf, e.text)) return true;
  if (ts.isObjectLiteralExpression(e) && e.properties.length === 1) {
    const prop = e.properties[0];
    if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'uri') return isProvenanced(prop.initializer, sf);
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'uri') return constFromMediaUri(sf, 'uri');
    return false;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require' && e.arguments.length === 1 && ts.isStringLiteral(e.arguments[0])) return true;
  if (ts.isStringLiteral(e) && !/^(https?:)?\/\//i.test(e.text) && !e.text.includes(':')) return true;
  return false;
}

/**
 * `name` is declared in this file ONLY as `const name = telegraphMediaUri(<one argument>)` (every declaration of
 * that name, so a shadowing declaration with another source cannot borrow the provenance).
 */
function constFromMediaUri(sf: ts.SourceFile, name: string): boolean {
  let seen = 0; let ok = 0;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      seen++;
      const list = n.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      const init = n.initializer;
      if (isConst && init && isMediaUriCall(init)) ok++;
    }
    if ((ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.name.text === name) seen++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return seen > 0 && seen === ok;
}

function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function definesApiBase(sf: ts.SourceFile, name: string): boolean {
  let ok = false;
  const visit = (n: ts.Node) => {
    if ((ts.isFunctionDeclaration(n) && n.name?.text === name) || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name)) {
      if (n.getText(sf).includes('EXPO_PUBLIC_API_BASE_URL')) ok = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return ok;
}

function isApiBaseUrl(arg: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  if (!arg || !ts.isTemplateExpression(arg) || arg.head.text !== '') return false;
  const first = arg.templateSpans[0]?.expression;
  if (!first) return false;
  const name = ts.isCallExpression(first) && ts.isIdentifier(first.expression) && first.arguments.length === 0
    ? first.expression.text
    : ts.isIdentifier(first) ? first.text : null;
  if (!name || !/^(apiBase|API_BASE)\w*$/.test(name)) return false;
  return definesApiBase(sf, name);
}

function bindingName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  let p = fn.parent;
  if (p && ts.isCallExpression(p) && calleeName(p.expression) === 'useCallback') p = p.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function pressBoundNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && PRESS_NAME.test(n.name.getText(sf)) && n.initializer && ts.isJsxExpression(n.initializer) &&
        n.initializer.expression && ts.isIdentifier(n.initializer.expression)) names.add(n.initializer.expression.text);
    if (ts.isPropertyAssignment(n) && PRESS_NAME.test(n.name.getText(sf)) && ts.isIdentifier(n.initializer)) names.add(n.initializer.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

function isPressBound(call: ts.Node, sf: ts.SourceFile, bound: Set<string>): boolean {
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
    if (!(ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))) continue;
    const p = n.parent;
    if (p && ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
      const callee = calleeName(p.expression);
      if (callee && EFFECTS.has(callee)) return false; // render-time, effect or timer: not a tap
    }
    if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent) && PRESS_NAME.test(p.parent.name.getText(sf))) return true;
    if (p && ts.isPropertyAssignment(p) && PRESS_NAME.test(p.name.getText(sf))) return true;
    const name = bindingName(n);
    if (name && bound.has(name)) return true;
  }
  return false;
}

export function analyze(files: string[], src: Source): { findings: Finding[]; keys: Map<string, number> } {
  const findings: Finding[] = [];
  const keys = new Map<string, number>(); // every pinnable site seen, with its count
  const see = (k: string) => keys.set(k, (keys.get(k) ?? 0) + 1);
  for (const rel of files) {
    const sf = ts.createSourceFile(rel, src.read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = importsOf(rel, sf, src.exists);
    const bound = pressBoundNames(sf);
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const add = (rule: Finding['rule'], n: ts.Node, key: string) => findings.push({ file: rel, line: line(n), rule, key });

    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === 'react-native-webview') add('WEBVIEW', st, `${rel} import react-native-webview`);
    }

    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ['WebSocket', 'XMLHttpRequest', 'EventSource'].includes(n.expression.text)) {
        add('SOCKET', n, `${rel} new ${n.expression.text}`);
      }
      if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression);
        if (name === 'fetch') {
          if (!isApiBaseUrl(n.arguments[0], sf)) {
            const key = `${rel} fetch(${norm(n.arguments[0]?.getText(sf) ?? '')})`;
            see(key); add('FETCH', n, key);
          }
        } else if (name && LOADERS.has(name)) {
          const key = `${rel} ${norm(n.getText(sf))}`;
          see(key); add('LOAD', n, key);
        } else if (name && OPENERS.has(name)) {
          if (!isPressBound(n, sf, bound)) add('OPEN', n, `${rel} ${norm(n.getText(sf))}`);
        }
      }
      if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
        const tagText = n.tagName.getText(sf);
        if (tagText === 'WebView' || tagText.endsWith('.WebView')) add('WEBVIEW', n, `${rel} <${tagText}>`);
        const props = sinkPropsFor(n.tagName, imports, rel);
        if (props) {
          for (const attr of n.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr)) { add('IMAGE', attr, `${rel} <${tagText} {${norm(attr.getText(sf))}}>`); continue; }
            const pname = attr.name.getText(sf);
            if (!props.includes(pname) || !attr.initializer) continue;
            const expr = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
            if (!expr) continue;
            const text = norm(expr.getText(sf));
            if (isProvenanced(expr, sf)) continue;
            const key = `${rel} <${tagText} ${pname}={${text}}>`;
            see(key); add('IMAGE', attr, key);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { findings, keys };
}

/** Findings no pin covers, and pins that are stale or under-counted. */
export function judge(result: { findings: Finding[]; keys: Map<string, number> }, pins: Pin[]): { unpinned: Finding[]; stale: string[]; grown: string[] } {
  const byKey = new Map(pins.map((p) => [p.key, p]));
  const unpinned = result.findings.filter((f) => !byKey.has(f.key) || f.rule === 'SOCKET' || f.rule === 'WEBVIEW' || f.rule === 'OPEN');
  const stale = pins.filter((p) => !result.keys.has(p.key)).map((p) => p.key);
  const grown = pins.filter((p) => (result.keys.get(p.key) ?? 0) > p.count).map((p) => `${p.key} — ${result.keys.get(p.key)} sites, pinned ${p.count}`);
  return { unpinned, stale, grown };
}

const ALL_PINS = [...IMAGE_PINS, ...FETCH_PINS, ...LOAD_PINS];

/**
 * THE CEILING (verifier S3). The pin list may only SHRINK: lower these when a pin goes, never raise them.
 * 39 entries / 40 sites on the head that set them (fix round 1: the 4 player primitives the playback host
 * brought into the closure). Raising either is a reviewable decision, not a fix.
 */
const PIN_CEILING = { entries: 39, sites: 40 };

// ── 1. the analyzer, on the mutants the plan names ───────────────────────────

function memory(files: Record<string, string>): Source {
  return { read: (rel) => files[rel], exists: (rel) => Object.prototype.hasOwnProperty.call(files, rel) };
}
const ROOT = 'src/components/FakeBubble.tsx';
const run = (body: string, extra: Record<string, string> = {}) => {
  const src = memory({ [ROOT]: body, ...extra });
  return judge(analyze(closureOf([ROOT], src), src), []);
};
const API = "function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }\n";

test('A1 mutant: a direct fetch of a message URL is a finding', () => {
  const r = run(`${API}export async function f(m: { body: string }) { await fetch(m.body); }`);
  assert.deepEqual(r.unpinned.map((f) => f.rule), ['FETCH']);
});

test('A2 mutant: <Image source={{ uri: rawUrl }}> from react-native or expo-image is a finding; through telegraphMediaUri it is not', () => {
  const rn = run(`import { Image } from 'react-native';\nexport const B = ({ rawUrl }: any) => <Image source={{ uri: rawUrl }} />;`);
  assert.deepEqual(rn.unpinned.map((f) => f.rule), ['IMAGE']);
  const expo = run(`import { Image as ExpoImage } from 'expo-image';\nexport const B = ({ rawUrl }: any) => <ExpoImage source={rawUrl} />;`);
  assert.deepEqual(expo.unpinned.map((f) => f.rule), ['IMAGE']);
  const ns = run(`import * as EI from 'expo-image';\nexport const B = ({ rawUrl }: any) => <EI.Image source={rawUrl} />;`);
  assert.deepEqual(ns.unpinned.map((f) => f.rule), ['IMAGE']);
  const ok = run(`import { Image } from 'react-native';\nimport { telegraphMediaUri } from '../features/telegraph/linkPreview/telegraphMediaUri.ts';\nexport const B = ({ rawUrl }: any) => <Image source={{ uri: telegraphMediaUri(rawUrl) ?? undefined }} />;`);
  assert.deepEqual(ok.unpinned, []);
  const asset = run(`import { Image } from 'react-native';\nexport const B = () => <Image source={require('../../assets/x.png')} />;`);
  assert.deepEqual(asset.unpinned, []);
});

test('A3 mutant: an app primitive (DisplayMediaImage, Avatar, VideoThumbnail) bound to a raw message URL is a finding — through an intermediate file too', () => {
  const r = run(
    `import { Wrapped } from './Wrapped.tsx';\nexport const B = (m: any) => <Wrapped url={m.body} />;`,
    {
      'src/components/Wrapped.tsx': `import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';\nimport { Avatar } from './ui/Avatar.tsx';\nexport const Wrapped = ({ url }: any) => <><DisplayMediaImage uri={url} width={1} height={1} /><Avatar uri={url} /></>;`,
      'src/components/ui/DisplayMediaImage.tsx': 'export const DisplayMediaImage = (p: any) => null;',
      'src/components/ui/Avatar.tsx': 'export const Avatar = (p: any) => null;',
    },
  );
  assert.deepEqual(r.unpinned.map((f) => `${f.rule} ${f.file}`), ['IMAGE src/components/Wrapped.tsx', 'IMAGE src/components/Wrapped.tsx']);
  const spread = run(`import { Image } from 'react-native';\nexport const B = (p: any) => <Image {...p} />;`);
  assert.deepEqual(spread.unpinned.map((f) => f.rule), ['IMAGE']);
});

test('A4 mutant: Image.prefetch (and every other loader) is a finding', () => {
  for (const call of ['Image.prefetch(m.body)', 'ExpoImage.prefetch([m.body])', 'Image.getSize(m.body, () => {})', 'FileSystem.downloadAsync(m.body, "x")']) {
    const r = run(`export function f(m: any) { ${call}; }`);
    assert.deepEqual(r.unpinned.map((f) => f.rule), ['LOAD'], call);
  }
});

test('A5 mutant: a WebView is a finding', () => {
  const r = run(`import { WebView } from 'react-native-webview';\nexport const B = (m: any) => <WebView source={{ uri: m.body }} />;`);
  assert.deepEqual(r.unpinned.map((f) => f.rule).sort(), ['WEBVIEW', 'WEBVIEW']);
});

test('A6 mutant: openURL in an effect, a timer or at render is a finding; in a press handler it is not', () => {
  for (const body of [
    `useEffect(() => { Linking.openURL(m.body); }, []);`,
    `setTimeout(() => { void Linking.openURL(m.body); }, 0);`,
    `Linking.openURL(m.body);`,
    `const go = useCallback(() => Linking.openURL(m.body), []); useEffect(() => { go(); }, [go]);`,
  ]) {
    const r = run(`import { Linking } from 'react-native';\nexport function B(m: any) { ${body} return null; }`);
    assert.deepEqual(r.unpinned.map((f) => f.rule), ['OPEN'], body);
  }
  for (const body of [
    `return <Pressable onPress={() => { void Linking.openURL(m.body); }} />;`,
    `return <Pressable onLongPress={() => { void (async () => { await Linking.openURL(m.body); })(); }} />;`,
    `function handlePress() { Linking.openURL(m.body); } return <Pressable onPress={handlePress} />;`,
    `const go = useCallback(() => Linking.openURL(m.body), []); return <Pressable onPress={go} />;`,
    `Alert.alert('Open?', '', [{ text: 'Open', onPress: () => Linking.openURL(m.body) }]); return null;`,
  ]) {
    const r = run(`import { Linking, Pressable, Alert } from 'react-native';\nexport function B(m: any) { ${body} }`);
    assert.deepEqual(r.unpinned, [], body);
  }
});

test('A7 fetch through the Portava API base is allowed by construction (T339 / T411’s re-authorization); a lookalike base is not', () => {
  assert.deepEqual(run(`${API}export async function f(id: string) { await fetch(\`\${apiBase()}/api/threads/\${id}/share-projections\`); }`).unpinned, []);
  assert.deepEqual(run(`${API}export async function f(path: string) { await fetch(\`\${apiBase()}\${path}\`); }`).unpinned, []);
  const fake = run(`function apiBase(m: any) { return m.body; }\nexport async function f(m: any) { await fetch(\`\${apiBase()}/x\`); }`);
  assert.deepEqual(fake.unpinned.map((f) => f.rule), ['FETCH']);
  const ws = run(`export function f(m: any) { return new WebSocket(m.body); }`);
  assert.deepEqual(ws.unpinned.map((f) => f.rule), ['SOCKET']);
});

test('A8 a pin is a count: one more identical site, or a pin that matches nothing, fails', () => {
  const body = `import { Image } from 'react-native';\nexport const B = ({ u }: any) => <><Image source={{ uri: u }} /><Image source={{ uri: u }} /></>;`;
  const src = memory({ [ROOT]: body });
  const res = analyze(closureOf([ROOT], src), src);
  const key = `${ROOT} <Image source={{ uri: u }}>`;
  assert.deepEqual(judge(res, [{ key, count: 2, why: 'x' }]), { unpinned: [], stale: [], grown: [] });
  assert.equal(judge(res, [{ key, count: 1, why: 'x' }]).grown.length, 1);
  assert.deepEqual(judge(res, [{ key, count: 2, why: 'x' }, { key: 'gone', count: 1, why: 'x' }]).stale, ['gone']);
});

test('A9 provenance through a const: `const u = telegraphMediaUri(x)` is allowed; a `let`, or a second declaration of the name from elsewhere, is not', () => {
  const head = `import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';\nimport { telegraphMediaUri } from '../features/telegraph/linkPreview/telegraphMediaUri.ts';\n`;
  const lib = { 'src/components/ui/DisplayMediaImage.tsx': 'export const DisplayMediaImage = (p: any) => null;' };
  assert.deepEqual(run(`${head}export const B = (m: any) => { const u = telegraphMediaUri(m.url); return <DisplayMediaImage uri={u} width={1} height={1} />; };`, lib).unpinned, []);
  assert.deepEqual(run(`${head}export const B = (m: any) => { let u = telegraphMediaUri(m.url); u = m.url; return <DisplayMediaImage uri={u} width={1} height={1} />; };`, lib).unpinned.map((f) => f.rule), ['IMAGE']);
  assert.deepEqual(run(`${head}const A = ({ u }: any) => <DisplayMediaImage uri={u} width={1} height={1} />;\nexport const B = (m: any) => { const u = telegraphMediaUri(m.url); return <A u={u} />; };`, lib).unpinned.map((f) => f.rule), ['IMAGE']);
});

test('A10 provenance is the WHOLE expression (verifier S1): a raw value beside the call, a second argument, or the call in another key is a finding', () => {
  const head = `import { Image } from 'react-native';\nimport { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';\nimport { telegraphMediaUri } from '../features/telegraph/linkPreview/telegraphMediaUri.ts';\n`;
  const lib = { 'src/components/ui/DisplayMediaImage.tsx': 'export const DisplayMediaImage = (p: any) => null;' };
  const found = (jsx: string) => run(`${head}export const B = ({ raw, x }: any) => ${jsx};`, lib).unpinned.map((f) => f.rule);
  assert.deepEqual(found(`<DisplayMediaImage uri={raw ?? telegraphMediaUri(x)} width={1} height={1} />`), ['IMAGE']);
  assert.deepEqual(found(`<DisplayMediaImage uri={telegraphMediaUri(x) ?? raw} width={1} height={1} />`), ['IMAGE']);
  assert.deepEqual(found(`<DisplayMediaImage uri={telegraphMediaUri(x, 'https://evil.example')} width={1} height={1} />`), ['IMAGE']);
  assert.deepEqual(found(`<Image source={{ uri: raw, cacheKey: telegraphMediaUri(x) }} />`), ['IMAGE']);
  assert.deepEqual(found(`<Image source={{ uri: telegraphMediaUri(x), headers: raw }} />`), ['IMAGE']);
  assert.deepEqual(found(`<DisplayMediaImage uri={'https://tracker.example/p.gif'} width={1} height={1} />`), ['IMAGE']);
  for (const ok of [
    `<DisplayMediaImage uri={telegraphMediaUri(x)} width={1} height={1} />`,
    `<DisplayMediaImage uri={telegraphMediaUri(x) ?? undefined} width={1} height={1} />`,
    `<DisplayMediaImage uri={(telegraphMediaUri(x) ?? '')} width={1} height={1} />`,
    `<Image source={{ uri: telegraphMediaUri(x) ?? undefined }} />`,
  ]) assert.deepEqual(found(ok), [], ok);
  // A const is provenance only when it is assigned from a ONE-argument call.
  assert.deepEqual(run(`${head}export const B = ({ x }: any) => { const u = telegraphMediaUri(x, 'https://evil.example'); return <DisplayMediaImage uri={u} width={1} height={1} />; };`, lib).unpinned.map((f) => f.rule), ['IMAGE']);
});

test('A11 sinks the tree does not use yet are modelled (verifier S2): Animated.Image, expo-image ImageBackground, SvgUri, a map Marker image, expo-video and file downloads', () => {
  const cases: Array<[string, string]> = [
    [`import { Animated } from 'react-native';\nexport const B = (m: any) => <Animated.Image source={{ uri: m.url }} />;`, 'IMAGE'],
    [`import { ImageBackground } from 'expo-image';\nexport const B = (m: any) => <ImageBackground source={m.url} />;`, 'IMAGE'],
    [`import { SvgUri } from 'react-native-svg';\nexport const B = (m: any) => <SvgUri uri={m.url} />;`, 'IMAGE'],
    [`import { Marker } from 'react-native-maps';\nexport const B = (m: any) => <Marker image={{ uri: m.url }} />;`, 'IMAGE'],
    [`import { useVideoPlayer } from 'expo-video';\nexport function B(m: any) { useVideoPlayer(m.url); return null; }`, 'LOAD'],
    [`import { File } from 'expo-file-system/next';\nexport async function f(m: any) { await File.downloadFileAsync(m.url, 'x'); }`, 'LOAD'],
    [`import * as WebBrowser from 'expo-web-browser';\nexport async function f(m: any) { await WebBrowser.mayInitWithUrlAsync(m.url); }`, 'LOAD'],
  ];
  for (const [body, rule] of cases) assert.deepEqual(run(body).unpinned.map((f) => f.rule), [rule], body);
});

test('A12 a platform variant (.native / .ios / .android / .web) is in the closure too (verifier P16)', () => {
  const spec = './Card'; // extensionless on purpose; interpolated so the repo's import-extension lint does not read the fixture as an import
  const src = memory({
    [ROOT]: `import { Card } from '${spec}';\nexport const B = (m: any) => <Card m={m} />;`,
    'src/components/Card.native.tsx': `import { Image } from 'react-native';\nexport const Card = ({ m }: any) => <Image source={{ uri: m.url }} />;`,
    'src/components/Card.web.tsx': `export const Card = (_p: any) => null;`,
  });
  const files = closureOf([ROOT], src);
  assert.ok(files.includes('src/components/Card.native.tsx') && files.includes('src/components/Card.web.tsx'), files.join(','));
  assert.deepEqual(judge(analyze(files, src), []).unpinned.map((f) => `${f.rule} ${f.file}`), ['IMAGE src/components/Card.native.tsx']);
});

// ── 2. the real tree ─────────────────────────────────────────────────────────

const disk: Source = {
  read: (rel) => readFileSync(join(APP_ROOT, rel), 'utf8'),
  exists: (rel) => existsSync(join(APP_ROOT, rel)) && statSync(join(APP_ROOT, rel)).isFile(),
};
const CLOSURE = closureOf(ROOTS, disk);

test('T1 the closure is the message tree, not an empty set (every surface that draws a message is in it)', () => {
  assert.ok(CLOSURE.length >= 100, `closure has ${CLOSURE.length} files`);
  for (const f of [
    ...ROOTS,
    'src/features/telegraph/linkPreview/MessageLinkPreview.tsx',
    'src/features/telegraph/linkPreview/ExternalUrlPreview.tsx',
    'src/features/telegraph/linkPreview/linkPreviewApi.ts',
    'src/components/MessageMediaBubble.tsx',
    'src/components/DiscoveryCardMessage.tsx',
    'src/components/PostCardMessage.tsx',
    'src/components/CompassCardMessage.tsx',
    'src/components/CircleStatusCardMessage.tsx',
    'src/components/TelegraphRecommendationCard.tsx',
    'src/components/RichText.tsx',
    'src/features/telegraph/sharing/PortavaObjectMessage.tsx',
    'src/features/telegraph/kinds/TypedMessageRenderer.tsx',
    'src/features/telegraph/voice/VoiceMessagePlayer.tsx',
    'src/features/telegraph/drawer/ContentDrawerSheet.tsx',
    'src/features/telegraph/savedMessages/SavedMessagesScreen.tsx',
    'src/features/telegraph/media/compactPlaybackStore.ts',
    'src/components/ui/SharedVideoPlayer.tsx',
  ]) assert.ok(CLOSURE.includes(f), `${f} is not in the scanned closure`);
});

test('T2 THE BOUNDARY: no request, loader, socket, web view, untapped open or image sink in the message tree reaches a host a message chose', () => {
  const result = analyze(CLOSURE, disk);
  if (process.env.MESSAGE_TREE_BOUNDARY_TABLE === '1') {
    // Print every pinnable site and its count: MESSAGE_TREE_BOUNDARY_TABLE=1 node --import tsx --test <this file>
    for (const [k, c] of [...result.keys.entries()].sort()) console.log(`${String(c).padStart(2)}  ${k}`);
  }
  const { unpinned, stale, grown } = judge(result, ALL_PINS);
  const show = (fs: Finding[]) => fs.map((f) => `  ${f.rule}  ${f.file}:${f.line}  ${f.key}`).join('\n');
  assert.deepEqual(unpinned, [], `\nThese sites can make a recipient's device contact a host a sender chose.\n` +
    `Bind an image source through telegraphMediaUri(…) (src/features/telegraph/linkPreview/telegraphMediaUri.ts), fetch only \`\${apiBase()}/api/…\`,\n` +
    `open a link only from a press handler. A site that is provably NOT derived from a message may be pinned above, with its reason.\n${show(unpinned)}`);
  assert.deepEqual(stale, [], 'stale pins (the site is gone — delete the pin)');
  assert.deepEqual(grown, [], 'a pinned site was copied — the pin is a count, not a pattern');
});

test('T3 the drawn preview is text: the link-preview modules import no image sink and no loader', () => {
  for (const f of ['src/features/telegraph/linkPreview/ExternalUrlPreview.tsx', 'src/features/telegraph/linkPreview/MessageLinkPreview.tsx']) {
    const text = disk.read(f);
    assert.doesNotMatch(text, /\b(Image|ImageBackground|ExpoImage|DisplayMediaImage|Avatar|CachedImage|VideoThumbnail|WebView)\b/, f);
    assert.doesNotMatch(text, /from 'expo-image'|from 'expo-av'|react-native-webview/, f);
  }
  const api = disk.read('src/features/telegraph/linkPreview/linkPreviewApi.ts');
  // The two requests: ids in the path or the query, and NO body on the sender's POST.
  assert.match(api, /fetch\(`\$\{apiBase\(\)\}\/api\/threads\/\$\{threadId\}\/link-previews\?ids=\$\{messageIds\.join\(','\)\}`/);
  assert.match(api, /fetch\(`\$\{apiBase\(\)\}\/api\/threads\/\$\{threadId\}\/messages\/\$\{messageId\}\/link-preview`, \{\n\s+method: 'POST',\n\s+headers: \{ Authorization: `Bearer \$\{token\}` \},\n\s+\}\)/);
});

test('T5 the pin list is under its ceiling — it may shrink, never grow', () => {
  assert.ok(ALL_PINS.length <= PIN_CEILING.entries, `${ALL_PINS.length} pins > ceiling ${PIN_CEILING.entries}`);
  const sites = ALL_PINS.reduce((n, p) => n + p.count, 0);
  assert.ok(sites <= PIN_CEILING.sites, `${sites} pinned sites > ceiling ${PIN_CEILING.sites}`);
});

test('T4 every pin says why', () => {
  for (const p of ALL_PINS) {
    assert.ok(p.why.length > 20, p.key);
    assert.ok(Number.isInteger(p.count) && p.count >= 1, p.key);
  }
});

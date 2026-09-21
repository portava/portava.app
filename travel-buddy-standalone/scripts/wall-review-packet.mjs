#!/usr/bin/env node
/**
 * wall-review-packet — assembles the DESIGN REVIEW BRIEF for census-wall rows
 * W159 ("generous whitespace") and W167 ("excessive badges").
 *
 * Usage, from travel-buddy-standalone:
 *
 *   node scripts/wall-review-packet.mjs --out /tmp/wall-review-packet.html
 *   node scripts/wall-review-packet.mjs --stdout > packet.html
 *   node scripts/wall-review-packet.mjs --check      # exit non-zero if a cited
 *                                                    # anchor moved; emits nothing
 *
 * No device, no simulator, no network, no build, no dependencies. It reads the
 * checked-out source with `fs` and writes one self-contained HTML file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS CANNOT DO, STATED FIRST BECAUSE IT IS THE THING PEOPLE WILL ASSUME
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT DOES NOT AND CANNOT PRODUCE SCREENSHOTS. There is no simulator,
 * no emulator and no device in the environment this was written in, and a
 * Node process with no renderer attached cannot rasterise a React Native tree.
 * Nothing it emits is a picture of a card. Every number in its output is a
 * value READ OUT OF THE SOURCE — a token, a prop, a cap, a style property —
 * not a measurement of anything drawn.
 *
 * Two artifacts therefore exist and they are not interchangeable:
 *
 *   docs/architecture/wall-cert-render-set.html   — the RENDERED cards
 *       (5 renderers x 2 densities x 5 widths), produced by actually running
 *       the components through react-dom + react-native-web. That is the thing
 *       a designer LOOKS AT. It is committed; this script does not rebuild it
 *       and must not be mistaken for it. Re-emit it with:
 *       WALL_CERT_EMIT=1 npx jest -c jest.web.config.js WallCertRenderSet
 *
 *   this script's output                          — the REFERENCE SHEET that
 *       goes beside it: what each renderer is, what data it can receive, which
 *       spacing and type tokens it actually uses and what those tokens resolve
 *       to in dp, and which structural limits are already machine-enforced and
 *       by which test. Its purpose is to keep the designer's attention on the
 *       one judgement the code cannot make, by answering in advance every
 *       structural question they would otherwise have to ask an engineer.
 *
 * AND NEITHER IS A SIGN-OFF. This script cannot approve or refuse anything. An
 * automated check is not a substitute for a named human's dated verdict. The
 * sign-off blocks it emits are EMPTY and stay empty until a person fills them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW IT AVOIDS LYING
 * ─────────────────────────────────────────────────────────────────────────────
 * Every `path:line` citation in the output is produced by `locate()`, which
 * SEARCHES the file for the anchor text at generation time and reports the line
 * it actually found. A hardcoded line number cannot go stale here because there
 * are none. If an anchor is gone entirely the run fails loudly (or, under
 * --check, exits 1) rather than emitting a citation that points at the wrong
 * code.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');            // travel-buddy-standalone
const REPO = resolve(PKG, '..');            // repository root
const WALL = resolve(PKG, 'src/features/wall');
const OBJECTS = resolve(WALL, 'components/objects');
const TOKENS = resolve(PKG, 'src/theme/tokens.ts');
const PROJECTION = resolve(WALL, 'types/wallProjection.ts');
const SHARED = resolve(OBJECTS, 'wallItemShared.tsx');
const DESIGN_TEST = resolve(WALL, 'components/__tests__/WallDesignSystem.component.test.tsx');
const CERT_FIXTURES = resolve(WALL, 'certification/wallCertFixtures.ts');
const DISPATCHER = resolve(WALL, 'components/WallObjectRenderer.tsx');

const problems = [];
const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(REPO, p);

/**
 * Cite a real line. Searches for `needle` and returns `path:line` using the
 * line it actually found, so the citation cannot drift. Records a problem
 * (rather than inventing a number) when the anchor is missing.
 */
function locate(path, needle, { optional = false } = {}) {
  const lines = read(path).split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  if (i === -1) {
    if (!optional) problems.push(`anchor not found in ${rel(path)}: ${JSON.stringify(needle)}`);
    return { cite: rel(path), line: null, text: null, found: false };
  }
  return { cite: `${rel(path)}:${i + 1}`, line: i + 1, text: lines[i].trim(), found: true };
}

// ── token tables, parsed out of the real theme file ──────────────────────────

const tokensSrc = read(TOKENS);

/** Grab the body of `export const <name> = { ... }` by brace matching. */
function constBody(src, name) {
  const head = src.indexOf(`export const ${name} = {`);
  if (head === -1) { problems.push(`token group not found: ${name}`); return ''; }
  const open = src.indexOf('{', head);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
  }
  problems.push(`unbalanced braces reading token group: ${name}`);
  return '';
}

/** Arithmetic-only evaluation, for values like `16 / 9`. No general eval. */
function arith(expr) {
  const e = expr.trim();
  if (!/^[\d\s./*+()-]+$/.test(e)) return null;
  try { return Function(`"use strict";return (${e});`)(); } catch { return null; }
}

/**
 * Flat scalar groups: space, radius, icon, aspect.
 *
 * Not line-anchored on purpose: `icon` and `aspect` are declared as one-liners
 * in tokens.ts while `space` and `radius` are multi-line. A per-line regex
 * silently returns an EMPTY table for the one-liners, which would have dropped
 * every icon and aspect-ratio token out of the brief without failing.
 */
function flatGroup(name) {
  const body = constBody(tokensSrc, name).replace(/\/\/[^\n]*/g, '');
  const out = {};
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([^,}\n]+)/g)) {
    const v = arith(m[2]);
    if (v !== null) out[m[1]] = v;
  }
  if (Object.keys(out).length === 0) problems.push(`token group parsed as empty: ${name}`);
  return out;
}

/** Nested style groups: `type` (hero/title/body/...). */
function nestedGroup(name) {
  const body = constBody(tokensSrc, name);
  const out = {};
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{([^}]*)\}/g)) {
    const props = {};
    for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*('[^']*'|"[^"]*"|[^,]+)/g)) {
      props[p[1]] = p[2].trim().replace(/^['"]|['"]$/g, '');
    }
    out[m[1]] = props;
  }
  return out;
}

const T = {
  space: flatGroup('space'),
  radius: flatGroup('radius'),
  icon: flatGroup('icon'),
  aspect: flatGroup('aspect'),
  type: nestedGroup('type'),
};

/** Render a token reference as `space.lg = 16`, from the real table. */
function resolveToken(group, key) {
  if (group === 'type' || group === 't') {
    const v = T.type[key];
    if (!v) return null;
    return `${v.fontSize}/${v.lineHeight}${v.fontWeight ? ` w${v.fontWeight}` : ''}`;
  }
  const v = T[group]?.[key];
  if (v === undefined) return null;
  return group === 'aspect' ? String(Math.round(v * 1000) / 1000) : String(v);
}

// ── the five object renderers, discovered not hardcoded ──────────────────────

/**
 * The five are the five files in components/objects/ that the dispatcher
 * actually imports. Discovered from the directory AND cross-checked against
 * WallObjectRenderer's import list, so a sixth renderer cannot be silently
 * left out of a review, and a file that is not a renderer (wallItemShared)
 * cannot be silently counted as one.
 */
function discoverRenderers() {
  const dispatcherSrc = read(DISPATCHER);
  // `wallItemShared` is imported by the dispatcher too, but it is the shared
  // building-block module (ActorByline, PlaceLine, the chip row, the action
  // row), not an object renderer. Excluded on both sides so it cannot be
  // counted as a sixth renderer nor reported as a missing one.
  const imported = new Set(
    [...dispatcherSrc.matchAll(/from '\.\/objects\/([A-Za-z0-9_]+)\.tsx'/g)]
      .map((m) => m[1])
      .filter((n) => n !== 'wallItemShared'),
  );
  const onDisk = readdirSync(OBJECTS)
    .filter((f) => f.endsWith('.tsx') && f !== 'wallItemShared.tsx')
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort();
  const renderers = onDisk.filter((n) => imported.has(n));
  const missed = onDisk.filter((n) => !imported.has(n));
  if (missed.length) {
    problems.push(`file(s) in components/objects/ not imported by the dispatcher: ${missed.join(', ')}`);
  }
  for (const n of imported) {
    if (!onDisk.includes(n)) problems.push(`dispatcher imports a renderer that is not on disk: ${n}`);
  }
  return renderers;
}

/** First block comment of a file, unwrapped, as the renderer's own summary. */
function headerDoc(src) {
  const m = src.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*ic?\s?/, '').replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Top-level entries of `const s = StyleSheet.create({...})`, brace matched. */
function styleSheet(src) {
  const head = src.indexOf('StyleSheet.create({');
  if (head === -1) return [];
  const open = src.indexOf('{', head + 'StyleSheet.create('.length - 1);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return [];
  const body = src.slice(open + 1, end);

  // split top-level `key: { ... },` entries
  const entries = [];
  let i = 0;
  while (i < body.length) {
    const m = /([A-Za-z_$][\w$]*)\s*:\s*\{/g;
    m.lastIndex = i;
    const hit = m.exec(body);
    if (!hit) break;
    let d = 0, j = m.lastIndex - 1;
    for (; j < body.length; j += 1) {
      if (body[j] === '{') d += 1;
      else if (body[j] === '}') { d -= 1; if (d === 0) break; }
    }
    entries.push({ name: hit[1], body: body.slice(m.lastIndex, j) });
    i = j + 1;
  }
  return entries.map((e) => ({
    name: e.name,
    props: e.body
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
      .filter(Boolean)
      .join(' ')
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim())
      .filter(Boolean),
  }));
}

/** Every `<group>.<key>` token reference in a file, with resolved values. */
function tokenUses(src) {
  const uses = new Map();
  const groups = { space: 'space', radius: 'radius', icon: 'icon', aspect: 'aspect', t: 'type' };
  for (const [alias, group] of Object.entries(groups)) {
    const re = new RegExp(`\\b${alias}\\.([A-Za-z0-9_$]+)`, 'g');
    for (const m of src.matchAll(re)) {
      const v = resolveToken(group, m[1]);
      if (v === null) continue;
      const label = `${group === 'type' ? 'type' : group}.${m[1]}`;
      const cur = uses.get(label) ?? { label, group, value: v, count: 0 };
      cur.count += 1;
      uses.set(label, cur);
    }
  }
  return [...uses.values()].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

function describeRenderer(name) {
  const path = resolve(OBJECTS, `${name}.tsx`);
  const src = read(path);
  const propsMatch = src.match(
    new RegExp(`export function ${name}\\(\\{\\s*projection\\s*\\}\\s*:\\s*\\{\\s*projection:\\s*(\\w+)`),
  );
  const projectionType = propsMatch?.[1] ?? null;
  if (!projectionType) problems.push(`could not read the projection type of ${name}`);

  // `[^}]*` — not `[\s\S]*?` — so the match cannot start at an earlier import
  // statement and swallow everything up to this one.
  const sharedImport = src.match(/import \{([^}]*)\} from '\.\/wallItemShared\.tsx'/);
  const shared = sharedImport
    ? sharedImport[1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // Counted, not assumed. Four of the five mount exactly one SocialActionRow;
  // PostcardWallItem mounts none (it is a whole-card tap into the Postcard
  // surface). Reporting "one action row" for all five would be wrong, and it
  // is exactly the kind of wrongness a designer would notice mid-review and
  // then stop trusting the rest of the sheet for.
  const actionRowMounts = [...src.matchAll(/<SocialActionRow\b/g)].length;
  const chipRowMounts = [...src.matchAll(/<ContextualActionChips\b/g)].length;
  const threadMounts = [...src.matchAll(/<ContextThreadView\b/g)].length;

  const objectTypeMatch = src.match(/testID=\{`wall-item-\$\{projection\.objectType\}`\}/);
  const clamps = [...src.matchAll(/numberOfLines=\{?(\d+)\}?/g)].map((m) => Number(m[1]));
  const hooks = [...src.matchAll(/\b(use[A-Z][A-Za-z0-9]*)\(/g)].map((m) => m[1]);

  return {
    name,
    path: rel(path),
    summary: headerDoc(src),
    projectionType,
    shared,
    actionRowMounts,
    chipRowMounts,
    threadMounts,
    rendersContextThread: /projection\.contextThread \?/.test(src),
    testIdIsObjectType: Boolean(objectTypeMatch),
    clamps: [...new Set(clamps)].sort((a, b) => a - b),
    hooks: [...new Set(hooks)].sort(),
    tokens: tokenUses(src),
    styles: styleSheet(src),
    lines: src.split('\n').length,
  };
}

// ── the projection data each renderer can receive ────────────────────────────

const projectionSrc = read(PROJECTION);

function interfaceFields(name) {
  const re = new RegExp(`export interface ${name}(?: extends (\\w+))? \\{`);
  const m = projectionSrc.match(re);
  if (!m) { problems.push(`interface not found: ${name}`); return { extends: null, fields: [] }; }
  const open = projectionSrc.indexOf('{', m.index);
  let depth = 0, end = -1;
  for (let i = open; i < projectionSrc.length; i += 1) {
    if (projectionSrc[i] === '{') depth += 1;
    else if (projectionSrc[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = projectionSrc.slice(open + 1, end);
  const fields = [];
  for (const fm of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)(\??):\s*([^;]+);/gm)) {
    fields.push({ name: fm[1], optional: fm[2] === '?', type: fm[3].replace(/\s+/g, ' ').trim() });
  }
  return { extends: m[1] ?? null, fields };
}

// ── the structural limits, with the tests that enforce them ──────────────────

function structuralLimits(renderers) {
  const chipCap = locate(SHARED, 'actions.slice(0, 3).map(');
  const chipExclusions = locate(SHARED, "(a) => a.type !== 'open_object' && a.type !== 'ask_compass' && a.type !== 'save'");
  const actionRow = locate(SHARED, '<View style={s.actionRow}>');
  const actionRowDecl = locate(SHARED, 'export function SocialActionRow(');
  const threadField = locate(PROJECTION, 'contextThread?: ContextThread;');
  const chipTest = locate(DESIGN_TEST, "it('an object with many actions renders at most THREE chips'");
  const exclusionTest = locate(DESIGN_TEST, "it('the actions that already have a home elsewhere are never ALSO badges'");
  const noChipRowTest = locate(DESIGN_TEST, "it('a card with no contextual actions carries no chip row at all'");
  const gridTest = locate(DESIGN_TEST, "it('nothing in the Wall lays content out in a grid'");
  const oneStripTest = locate(DESIGN_TEST, "it('there is exactly ONE horizontally-browsable recommendation surface'");
  const spacingTest = locate(DESIGN_TEST, "it('no Wall style sets an in-scale-band spacing value that is not a token'");

  return [
    {
      limit: 'At most THREE contextual chips per card',
      how: 'The chip list is hard-sliced to three before it is mapped.',
      code: chipCap,
      test: chipTest,
      note: 'Mutation-checked upstream: raising the slice to 6 turns the test red.',
    },
    {
      limit: 'Chips never duplicate an affordance that has a home elsewhere',
      how: '`open_object` is the whole-card tap, `ask_compass` is the place-line affordance, `save` is the bookmark in the action row. All three are filtered out before the cap applies, so the three chips are three DISTINCT additional actions.',
      code: chipExclusions,
      test: exclusionTest,
    },
    {
      limit: 'A card with no contextual actions has no chip row at all',
      how: 'The component returns null rather than an empty row.',
      code: locate(SHARED, 'if (actions.length === 0) return null;'),
      test: noChipRowTest,
    },
    {
      limit: 'At most ONE action row per card',
      how: '`SocialActionRow` renders a single flex row (stamp / comment / share / spacer / save). Mount sites counted in the five renderers at generation time: '
        + renderers.map((r) => `${r.name} ${r.actionRowMounts}`).join(', ')
        + '. No renderer mounts it twice.',
      code: actionRow,
      test: 'no dedicated test — held by the single call site per renderer, counted above',
      note: `Declared at ${actionRowDecl.cite}. Note the asymmetry, which is real and deliberate: `
        + `${renderers.filter((r) => r.actionRowMounts === 0).map((r) => r.name).join(', ') || 'no renderer'} `
        + `carries NO action row — it is a whole-card tap into its own surface. The W167 question is about the `
        + `cards that DO carry one.`,
    },
    {
      limit: 'At most ONE context thread per card',
      how: 'The projection carries a single optional `contextThread`, not a list, so no card can render two. Every renderer guards it with `projection.contextThread ? ... : null`.',
      code: threadField,
      test: 'the type is the enforcement — no test needed, and none would be stronger',
      note: 'Enforced by the type, not by a runtime check: an array would be needed to exceed one and the field is not an array.',
    },
    {
      limit: 'No dashboard grid anywhere in the Wall',
      how: 'No `numColumns` in the Wall tree; the single wrapping flex row is the action-chip row.',
      code: null,
      test: gridTest,
    },
    {
      limit: 'Exactly one horizontally-browsable recommendation surface',
      how: 'One `<LiveForYouStrip`, and exactly two horizontal scrollers in the whole tree (the strip and the quick-media row).',
      code: null,
      test: oneStripTest,
    },
    {
      limit: 'Every in-band spacing value is a token, not a literal',
      how: 'Scans every non-test Wall source and refuses any padding/margin/gap literal in the 4–48 band that is not one of the seven `space` steps.',
      code: locate(TOKENS, 'export const space = {'),
      test: spacingTest,
    },
  ];
}

// ── width range ──────────────────────────────────────────────────────────────

function widthRange() {
  const certWidths = locate(CERT_FIXTURES, 'export const CERT_WIDTHS =');
  const widths = certWidths.found
    ? [...(certWidths.text ?? '').matchAll(/\d+/g)].map((m) => Number(m[0]))
    : [];
  const appJson = JSON.parse(read(resolve(PKG, 'app.json')));
  const wallReadsWidth = /useWindowDimensions|Dimensions\.get/.test(
    readdirSync(resolve(WALL, 'components'), { recursive: true })
      .filter((f) => typeof f === 'string' && /\.tsx?$/.test(f) && !f.includes('__tests__'))
      .map((f) => read(resolve(WALL, 'components', f)))
      .join('\n'),
  );
  return {
    widths,
    certWidths,
    orientation: appJson.expo?.orientation ?? null,
    supportsTablet: appJson.expo?.ios?.supportsTablet ?? null,
    layoutMaxWidth: locate(TOKENS, 'maxWidth: 720,'),
    wallReadsWidth,
  };
}

// ── HTML emission ────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Render a citation cell. Three shapes, kept distinct on purpose so the sheet
 * never shows a source file in a column headed "enforcing test":
 *   - a locate() result  -> `path:line`
 *   - a plain string     -> prose (e.g. "the type, not a test")
 *   - null               -> an em dash with why there is nothing to cite
 */
function citeHtml(c, nothing = '&mdash;') {
  if (c === null || c === undefined) return `<span class="dim">${nothing}</span>`;
  if (typeof c === 'string') return `<span class="dim">${esc(c)}</span>`;
  if (!c.found) return '<span class="missing">anchor not found</span>';
  return `<code>${esc(c.cite)}</code>`;
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function emit(renderers, limits, widths) {
  const sha = gitSha();
  const now = new Date().toISOString();

  const rendererSections = renderers.map((r) => {
    const iface = r.projectionType ? interfaceFields(r.projectionType) : { extends: null, fields: [] };
    const base = iface.extends ? interfaceFields(iface.extends) : { fields: [] };
    return `
    <section class="renderer" id="${esc(r.name)}">
      <h3>${esc(r.name)}</h3>
      <p class="path"><code>${esc(r.path)}</code> &middot; ${r.lines} lines</p>
      ${r.summary.slice(0, 2).map((p) => `<p class="summary">${esc(p)}</p>`).join('')}

      <h4>Composition it can reach</h4>
      <table>
        <tr><th>Action row (stamp / comment / share / save)</th><td>${r.actionRowMounts === 0 ? '<strong>none</strong> — whole-card tap instead' : `${r.actionRowMounts} mount${r.actionRowMounts === 1 ? '' : 's'}`}</td></tr>
        <tr><th>Contextual chip row (capped at 3)</th><td>${r.chipRowMounts} mount${r.chipRowMounts === 1 ? '' : 's'}</td></tr>
        <tr><th>Context thread (at most one)</th><td>${r.threadMounts} mount${r.threadMounts === 1 ? '' : 's'}${r.rendersContextThread ? ', guarded on a single optional field' : ''}</td></tr>
        <tr><th>Shared building blocks</th><td>${r.shared.map((s) => `<code>${esc(s)}</code>`).join(', ') || '&mdash;'}</td></tr>
        <tr><th>Text clamps (<code>numberOfLines</code>)</th><td>${r.clamps.length ? r.clamps.join(', ') : '&mdash;'}</td></tr>
        <tr><th>Hooks used</th><td>${r.hooks.length ? r.hooks.map((h) => `<code>${esc(h)}</code>`).join(', ') : '&mdash;'}</td></tr>
      </table>

      <h4>Props — <code>${esc(r.projectionType ?? '?')}</code></h4>
      <table class="fields">
        <thead><tr><th>Field</th><th>Type</th><th>Source</th></tr></thead>
        <tbody>
        ${iface.fields.map((f) => `<tr><td><code>${esc(f.name)}${f.optional ? '?' : ''}</code></td><td><code>${esc(f.type)}</code></td><td>own</td></tr>`).join('')}
        ${base.fields.map((f) => `<tr class="inherited"><td><code>${esc(f.name)}${f.optional ? '?' : ''}</code></td><td><code>${esc(f.type)}</code></td><td>${esc(iface.extends ?? '')}</td></tr>`).join('')}
        </tbody>
      </table>

      <h4>Tokens this renderer actually uses</h4>
      <table class="tokens">
        <thead><tr><th>Token</th><th>Resolves to</th><th>Uses</th></tr></thead>
        <tbody>
        ${r.tokens.map((t) => `<tr><td><code>${esc(t.label)}</code></td><td>${esc(t.value)}${t.group === 'type' ? ' <span class="dim">(size/line)</span>' : t.group === 'aspect' ? '' : ' dp'}</td><td>${t.count}</td></tr>`).join('')}
        </tbody>
      </table>

      <h4>Its stylesheet, as written</h4>
      <table class="styles">
        <thead><tr><th>Style</th><th>Properties</th></tr></thead>
        <tbody>
        ${r.styles.map((s) => `<tr><td><code>${esc(s.name)}</code></td><td>${s.props.map((p) => `<code>${esc(p)}</code>`).join(' ')}</td></tr>`).join('')}
        </tbody>
      </table>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wall design review brief — W159 / W167</title>
<style>
  :root {
    --ink: #11110F; --paper: #FAF9F6; --raised: #FFFFFF; --haze: #E8E5DE;
    --mute: #6B6862; --faint: #9C988F; --signal: #FF4D2E; --deep: #0A3D4A;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px 96px; background: var(--paper); color: var(--ink);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 26px; line-height: 1.2; letter-spacing: -0.5px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 44px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--ink); }
  h3 { font-size: 17px; margin: 28px 0 2px; }
  h4 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--mute); margin: 20px 0 6px; }
  code { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #EFEDE7; padding: 1px 4px; border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; background: var(--raised); }
  th, td { text-align: left; vertical-align: top; padding: 6px 9px; border-bottom: 1px solid var(--haze); font-size: 13px; }
  thead th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--mute); }
  tr.inherited td { color: var(--mute); }
  .banner { border: 2px solid var(--signal); background: #FFF3F0; padding: 14px 16px; border-radius: 8px; margin: 18px 0; }
  .banner h2 { border: 0; margin: 0 0 6px; font-size: 15px; color: var(--signal); text-transform: uppercase; letter-spacing: 0.6px; }
  .meta { color: var(--mute); font-size: 12px; margin: 0 0 18px; }
  .path { color: var(--mute); margin: 0 0 8px; font-size: 12px; }
  .summary { margin: 4px 0; color: #33312C; }
  .renderer { background: var(--raised); border: 1px solid var(--haze); border-radius: 10px; padding: 16px 18px; margin: 16px 0; }
  .signoff { border: 2px dashed var(--deep); border-radius: 10px; padding: 16px 18px; margin: 14px 0; background: var(--raised); }
  .signoff .unfilled { color: var(--signal); font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; font-size: 12px; }
  .blank { display: inline-block; min-width: 220px; border-bottom: 1px solid var(--ink); }
  .dim { color: var(--faint); }
  .missing { color: var(--signal); font-weight: 700; }
  .q { background: #FFFDF5; border-left: 4px solid var(--deep); padding: 10px 14px; margin: 10px 0; }
  ul { margin: 6px 0 6px 20px; padding: 0; }
  @media print { body { padding: 0; } .renderer, .signoff { break-inside: avoid; } }
</style>
</head>
<body>
<main>

<h1>Wall design review brief</h1>
<p class="meta">
  census-wall rows <strong>W159</strong> (generous whitespace) and <strong>W167</strong> (excessive badges).<br>
  Generated ${esc(now)}${sha ? ` from <code>${esc(sha)}</code>` : ''} by <code>travel-buddy-standalone/scripts/wall-review-packet.mjs</code>.
  Every value below was read out of the source at generation time.
</p>

<div class="banner">
  <h2>What this sheet is not</h2>
  <p><strong>It contains no screenshots and no rendered cards.</strong> This script runs in Node with no
  simulator, emulator or device attached and cannot rasterise a React Native tree. Nothing here is a picture
  of anything. Every number is a token, a prop or a cap read out of the source.</p>
  <p><strong>Look at the cards here:</strong> <code>docs/architecture/wall-cert-render-set.html</code> — the
  five renderers &times; two densities &times; five widths, actually rendered through
  <code>react-native-web</code>. That file is the review subject. This sheet is the reference that goes
  beside it, so no structural question has to be asked of an engineer mid-review.</p>
  <p><strong>And no automated check substitutes for the sign-off.</strong> The limits listed below are
  enforced by tests; the question of whether those limits are the RIGHT limits is the judgement no test can
  make and the reason a named designer is being asked. The sign-off blocks at the end are empty.</p>
</div>

<h2>The two questions</h2>
<div class="q">
  <p><strong>W159.</strong> Across the five object renderers at every reviewed width, does the spacing read
  as <em>generous</em> rather than cramped &mdash; and at the widest width, as deliberate rather than empty?
  <br><strong>Answer: APPROVED or REFUSED.</strong></p>
</div>
<div class="q">
  <p><strong>W167.</strong> On the densest card the code can currently emit &mdash; one action row, three
  chips, one context thread, a place line, text and a media well &mdash; is that <em>already too much</em>?
  <br><strong>Answer: APPROVED (not too much) or REFUSED (too much) — and a refusal must name a number or an
  element to remove.</strong></p>
</div>
<p>The full wording, the pass conditions and the recording blocks are in
<code>docs/wall/measurement/W159-W167-design-review-packet.md</code>.</p>

<h2>Widths under review</h2>
<p>
  <strong>The repository declares no supported width range.</strong> No breakpoint is defined in the theme,
  and the Wall components read no viewport width at all
  (<code>useWindowDimensions</code> / <code>Dimensions.get</code> in the Wall component tree:
  <strong>${widths.wallReadsWidth ? 'present — this sheet is out of date' : 'none'}</strong>).
  Width therefore switches no layout; it only moves where text wraps, how tall a fixed-aspect media well is,
  and whether the chip row wraps.
</p>
<p>
  What the repository <em>does</em> state: <code>app.json</code> pins
  <code>orientation: ${esc(String(widths.orientation))}</code> and
  <code>ios.supportsTablet: ${esc(String(widths.supportsTablet))}</code> &mdash; phone portrait only. The only
  width constant in the theme is a desktop/tablet content cap at ${citeHtml(widths.layoutMaxWidth)}, which the
  Wall does not use.
</p>
<p>
  The widths the review set is built at are <strong>${widths.widths.join(', ')} dp</strong>
  (${citeHtml(widths.certWidths)}). <strong>That range is a proposal, not a repo fact</strong>, and the owner
  confirms or replaces it before the review runs.
</p>

<h2>Structural limits already enforced — do not ask the designer about these</h2>
<p>Each row below is a limit the code applies and a test holds. They are listed so the review can skip them
and spend its attention on the judgement.</p>
<table>
  <thead><tr><th>Limit</th><th>How</th><th>Code</th><th>Enforcing test</th></tr></thead>
  <tbody>
  ${limits.map((l) => `<tr>
    <td><strong>${esc(l.limit)}</strong>${l.note ? `<br><span class="dim">${esc(l.note)}</span>` : ''}</td>
    <td>${esc(l.how)}</td>
    <td>${citeHtml(l.code, 'an absence &mdash; nothing to cite, which is the point')}</td>
    <td>${citeHtml(l.test)}</td>
  </tr>`).join('')}
  </tbody>
</table>

<h2>The five object renderers</h2>
<p>Discovered at generation time from <code>${esc(rel(OBJECTS))}</code>, cross-checked against the imports in
<code>${esc(rel(DISPATCHER))}</code>. ${renderers.length} found.</p>
${rendererSections}

<h2>The spacing scale, in full</h2>
<table>
  <thead><tr><th>Token</th><th>dp</th></tr></thead>
  <tbody>${Object.entries(T.space).map(([k, v]) => `<tr><td><code>space.${esc(k)}</code></td><td>${v}</td></tr>`).join('')}</tbody>
</table>
<p class="dim">Read from <code>${esc(rel(TOKENS))}</code>. Any padding/margin/gap literal in the 4&ndash;48 band
that is not one of these fails the spacing scanner, so whatever is signed off cannot silently drift.</p>

<h2>Sign-off</h2>
<p>A <strong>refusal is as valid an outcome as an approval</strong>. Either one moves the row; neither is the
preferred answer. What does not move the row is an unsigned or undated review, or a review by someone who is
not the named design owner &mdash; the content of both rows is <em>whose</em> judgement it is.</p>

<div class="signoff">
  <p class="unfilled">Unfilled — no designer has reviewed this. Nothing below is a result.</p>
  <h3>W159 &mdash; spacing and whitespace</h3>
  <p>Designer (printed name): <span class="blank"></span></p>
  <p>Date: <span class="blank"></span></p>
  <p>Verdict: &nbsp; &#9744; APPROVED &nbsp;&nbsp; &#9744; REFUSED</p>
  <p>If REFUSED, the card id and width it fails at: <span class="blank"></span></p>
  <p>Notes:</p>
  <p><span class="blank" style="min-width:100%"></span></p>
  <p><span class="blank" style="min-width:100%"></span></p>
</div>

<div class="signoff">
  <p class="unfilled">Unfilled — no designer has reviewed this. Nothing below is a result.</p>
  <h3>W167 &mdash; is the ceiling density already too much?</h3>
  <p>Designer (printed name): <span class="blank"></span></p>
  <p>Date: <span class="blank"></span></p>
  <p>Verdict: &nbsp; &#9744; APPROVED (not too much) &nbsp;&nbsp; &#9744; REFUSED (too much)</p>
  <p>If REFUSED, maximum contextual chips I would accept on one card: <span class="blank" style="min-width:60px"></span></p>
  <p>&#9744; the context thread should not appear on a card that already has chips<br>
     &#9744; the Ask Compass affordance is one affordance too many<br>
     &#9744; other: <span class="blank"></span></p>
  <p>Notes:</p>
  <p><span class="blank" style="min-width:100%"></span></p>
  <p><span class="blank" style="min-width:100%"></span></p>
</div>

</main>
</body>
</html>
`;
}

// ── main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const wantsCheck = argv.includes('--check');
const toStdout = argv.includes('--stdout');
const outIdx = argv.indexOf('--out');
const outPath = outIdx !== -1 ? argv[outIdx + 1] : null;

const renderers = discoverRenderers().map(describeRenderer);
const limits = structuralLimits(renderers);
const widths = widthRange();

if (renderers.length !== 5) {
  problems.push(
    `expected 5 object renderers, found ${renderers.length}: ${renderers.map((r) => r.name).join(', ') || '(none)'}. ` +
      'census-wall W159/W167 both say "five object renderers" — if the count really changed, the census rows ' +
      'and the review set need updating before a sign-off means anything.',
  );
}

if (problems.length) {
  for (const p of problems) console.error(`wall-review-packet: PROBLEM: ${p}`);
}

if (wantsCheck) {
  if (problems.length) {
    console.error(`wall-review-packet --check: ${problems.length} problem(s). No packet emitted.`);
    process.exit(1);
  }
  console.log(
    `wall-review-packet --check: OK. ${renderers.length} renderers, ` +
      `${limits.length} structural limits, all anchors resolve.`,
  );
  process.exit(0);
}

if (problems.length) {
  console.error(
    'wall-review-packet: refusing to emit a packet with unresolved anchors — a review brief that cites ' +
      'code that is not there is worse than no brief.',
  );
  process.exit(1);
}

const html = emit(renderers, limits, widths);

if (toStdout) {
  process.stdout.write(html);
} else {
  const dest = resolve(process.cwd(), outPath ?? 'wall-review-packet.html');
  writeFileSync(dest, html, 'utf8');
  console.log(`wall-review-packet: wrote ${dest} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`  renderers:          ${renderers.map((r) => r.name).join(', ')}`);
  console.log(`  structural limits:  ${limits.length}`);
  console.log(`  widths in the set:  ${widths.widths.join(', ')} dp (a proposal — see the sheet)`);
  console.log('  screenshots:        NONE. This script cannot render cards; see the banner in the output.');
  console.log('  sign-off blocks:    EMPTY, and stay empty until a named designer fills them.');
}

/**
 * DV-83's STATIC GUARD — every consumer of a Discovery read that can carry a
 * refusal is named here, with the branch it takes and the test that proves it.
 *
 * census-discovery DV-83 (`11` §9 / owner ruling D11, the CONSUMER leg): *"A
 * distinguishable response body alone is insufficient if consumers still treat
 * it as successful empty data."* §29.2 left the row `W` on, among other things,
 * this ground: *"Nothing enforces the invariant statically. … It is held by
 * per-consumer tests alone, which is exactly how the rail sat non-compliant
 * with the suite green for as long as it did. The eleventh consumer is
 * unconstrained today."* This file is the constraint.
 *
 * WHAT IT CHECKS, AND HOW EACH HALF IS DERIVED RATHER THAN RESTATED
 *  1. The CARRIERS — the functions of `services/discovery.ts` whose answer can
 *     hold a refusal — are derived from that file: an exported function that
 *     parses one (`parseRefusal` / `withParsedRefusal` / `refusedEverything`)
 *     or returns a type that declares a `refusal` member. The derived set is
 *     pinned, so a new carrier fails here until its consumers are accounted for.
 *  2. The CONSUMERS are derived from the tree: every file under `src/` and
 *     `app/` that value-imports a carrier, or a hook in WRAPPERS that forwards
 *     one. Each must have an entry in CONSUMERS, or this fails naming it.
 *  3. Each entry names the branch it takes (a source fragment that must still be
 *     present) and the suite that proves it on screen (which must exist and be
 *     a refusal suite). An entry whose file no longer imports what it claims is
 *     stale and fails too, so the registry cannot rot into a list of names.
 *
 *  4. census-discovery §80 (register D-W10-S1-2) decided the row's open question
 *     (§60.8 Q1): a consumer may NOT render `coverage: "partial"` as a complete
 *     answer. Every consumer that RENDERS A LIST names the branch that says the
 *     list is incomplete (`partialBranches`, G7); one that renders no list says
 *     why the rule does not reach it. The wording has one home,
 *     `services/discoveryCoverageNotice.ts`, and G8 pins its text.
 *
 * WHAT IT DOES NOT CHECK. Whether the branch is RIGHT is the proof suite's job;
 * a fragment in a file is evidence the branch exists, not that it works.
 *
 * Run: node --import tsx/esm --test src/services/__tests__/discoveryRefusalConsumers.guard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');   // travel-buddy-standalone/
const SERVICE = 'src/services/discovery.ts';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The carriers, as of census-discovery §60. A change to this list is a change
 * to DV-83's scope: add the function here AND its consumers below.
 */
const EXPECTED_CARRIERS = [
  'getCachedDiscoveryPlaces',
  'getCommunityPlaces',
  'getDiscoveryCategoryCounts',
  'getDiscoveryCategoryCountsBatch',
  'getDiscoveryFeed',
  'getDiscoveryPlaces',
  'getSavedPlaceIds',
  'getSearchSuggestions',
  'searchUnified',
];

/**
 * census-discovery §80 (A08 reason 3): the Map search sheet reads the input
 * gateway's search page, whose envelope carries the same refusal vocabulary.
 * Carriers outside `services/discovery.ts`, pinned by module.
 */
const EXTRA_CARRIERS: Record<string, string[]> = {
  'src/platform/input-assistance/services/inputAssistance.ts': ['requestMapSearchPage'],
};

/** Hooks that take a carrier's answer and hand a `refused` flag on. Their importers are consumers too. */
const WRAPPERS: Record<string, string> = {
  useCommunityDiscovery: 'src/hooks/useCommunityDiscovery.ts',
  useSearchSuggestions: 'src/hooks/useSearchSuggestions.ts',
  useGlobalSearchSuggestions: 'src/hooks/useGlobalSearchSuggestions.ts',
};

interface Consumer {
  /** What the file value-imports from the service or a wrapper. Exact. */
  uses: string[];
  /** Source fragments that must still be present: the branch, not a comment about it. */
  branches: string[];
  /** Suites that prove the branch, each with a phrase that must appear in it. */
  proofs: Array<{ file: string; mentions: string }>;
  /** What a `coverage: "partial"` answer does here (§80, D-W10-S1-2). */
  partial: string;
  /**
   * §80: the source fragments that say "incomplete" — for a consumer that
   * renders a list, non-empty (G7). Empty only where `partial` says why the
   * rule does not reach this file.
   */
  partialBranches: string[];
}

const CONSUMERS: Record<string, Consumer> = {
  'src/components/discovery/ForYouTab.tsx': {
    uses: ['getCachedDiscoveryPlaces', 'getDiscoveryPlaces', 'getSavedPlaceIds', 'useCommunityDiscovery'],
    branches: [
      "setSource(osm.ok && osm.data.refusal?.coverage === 'nothing' ? 'refused' : 'none');",
      '{community.refused && (',
      "setSavedIdsUnavailable(res.reason !== 'signed_out');",
    ],
    proofs: [
      { file: 'src/components/discovery/__tests__/ForYouTab.refusal.component.test.tsx', mentions: 'for-you-community-refused' },
      { file: 'src/components/discovery/__tests__/ForYouTab.refusal.component.test.tsx', mentions: 'for-you-partial' },
    ],
    partial: 'rows kept, one "may be incomplete" line per lane; no rows is never "No recommendations yet"',
    partialBranches: [
      "{source === 'osm' && osmPartial && (",
      "{source === 'none' && osmPartial && (",
      '{community.incomplete && !community.refused && (',
    ],
  },
  'src/components/discovery/DiscoveryCategoryTab.tsx': {
    uses: ['getCachedDiscoveryPlaces', 'getDiscoveryPlaces'],
    branches: [
      "if (nextPage === 1 && res.data.refusal?.coverage === 'nothing') {",
      "if (res.data.refusal?.coverage === 'nothing') {\n      setMoreRefused(true);",
    ],
    proofs: [
      { file: 'src/components/discovery/__tests__/DiscoveryCategoryTab.refusal.component.test.tsx', mentions: 'does NOT tell the user to adjust their filters' },
      { file: 'src/components/discovery/__tests__/DiscoveryCategoryTab.loadMoreRefusal.component.test.tsx', mentions: 'a refused page 2 is not the last page' },
    ],
    partial: 'rows kept under a "may be incomplete" line; no rows is the partial-empty state with a retry, never "No places found"',
    partialBranches: ['ListHeaderComponent={partial ?', ') : places.length === 0 && partial ? ('],
  },
  'src/components/discovery/DiscoveryEventPostsRail.tsx': {
    uses: ['getDiscoveryFeed'],
    branches: ["setRefused(res.data.refusal?.coverage === 'nothing');", 'if (refused) {'],
    proofs: [{ file: 'src/components/discovery/__tests__/DiscoveryEventPostsRail.refusal.component.test.tsx', mentions: 'discovery-event-posts-rail-refused' }],
    partial: "n/a — the feed's partial names PLACE categories (failedCats); this rail renders only event posts, which that partial does not cover",
    partialBranches: [],
  },
  'src/hooks/useCommunityDiscovery.ts': {
    uses: ['getCommunityPlaces'],
    branches: ["const refused = result.data.refusal?.coverage === 'nothing';", 'if (cKey && !refused && isCurrentDiscoveryScope(scope)) {'],
    proofs: [{ file: 'src/hooks/__tests__/useCommunityDiscovery.refusal.component.test.tsx', mentions: 'refused' }],
    partial: 'rows kept and cached WITH `incomplete`, so a cached replay still says so',
    partialBranches: ["incomplete: result.data.refusal?.coverage === 'partial'"],
  },
  'src/hooks/useSearchSuggestions.ts': {
    uses: ['getSearchSuggestions'],
    branches: ["const refusedNow = res.refusal?.coverage === 'nothing';"],
    proofs: [{ file: 'src/hooks/__tests__/useSearchSuggestions.refusal.component.test.tsx', mentions: 'refused' }],
    partial: 'groups kept and cached WITH `incomplete`, so a cached replay still says so',
    partialBranches: ["setIncomplete(!refusedNow && res.refusal?.coverage === 'partial');", "incomplete: res.refusal?.coverage === 'partial' });"],
  },
  'src/hooks/useGlobalSearchSuggestions.ts': {
    uses: ['useSearchSuggestions'],
    branches: ["refused: preferGateway ? gateway.refusal?.coverage === 'nothing' : legacy.refused,"],
    proofs: [{ file: 'src/hooks/__tests__/useGlobalSearchSuggestions.refused.component.test.tsx', mentions: 'the hook reports refused' }],
    partial: 'groups passed through with `incomplete`, from the legacy read or the gateway envelope',
    partialBranches: ["incomplete: preferGateway ? gateway.refusal?.coverage === 'partial' : legacy.incomplete,"],
  },
  'app/search.tsx': {
    uses: ['searchUnified', 'useGlobalSearchSuggestions'],
    branches: ["if (res.data.refusal?.coverage === 'nothing') {", 'refused: suggestRefused,', 'refused={suggestRefused}'],
    proofs: [{ file: 'app/__tests__/search.refusal.component.test.tsx', mentions: 'refus' }],
    partial: 'rows rendered with the "incomplete" notice; the suggestions panel says it too',
    partialBranches: ['{SEARCH_PARTIAL_NOTICE}', 'incomplete={suggestIncomplete}'],
  },
  'src/components/map/MapSearchSheet.tsx': {
    uses: ['requestMapSearchPage'],
    branches: ["const allRefusedEverything = allRefusal?.coverage === 'nothing';", "const savedFailed = res.savedRefusal?.coverage === 'nothing';"],
    proofs: [{ file: 'src/components/map/__tests__/MapSearchSheet.refusal.component.test.tsx', mentions: 'refus' }],
    partial: 'rows rendered with the "incomplete" notice, per lane',
    partialBranches: ["const allPartial = allRefusal?.coverage === 'partial';", 'const NOTICE_PARTIAL = SEARCH_PARTIAL_NOTICE;'],
  },
  'app/map/index.tsx': {
    uses: ['getDiscoveryPlaces'],
    branches: ["if (res.ok && (res.data?.refusal?.coverage === 'nothing' || isPartialEmpty(res.data?.refusal, res.data?.places))) {"],
    proofs: [{ file: 'app/map/__tests__/projectedPlaces.component.test.tsx', mentions: 'a refusal is not a zero-results map' }],
    partial: 'pins drawn under a "may be incomplete" banner; no places is the retryable error card, never the zero-results state',
    partialBranches: ['isPartialEmpty(res.data?.refusal, res.data?.places)', 'testID="map-places-partial"'],
  },
  // Prefetch: the answers are DISCARDED (warmed into the service's own cache,
  // which never holds a `coverage: "nothing"` body — discovery.refusal suite).
  'app/(tabs)/_layout.tsx': {
    uses: ['getDiscoveryCategoryCountsBatch', 'getDiscoveryPlaces'],
    branches: ['getDiscoveryCategoryCountsBatch(prefetchCity, 10).catch(() => {});', ').catch(() => {});\n    }, 300);'],
    proofs: [{ file: 'src/services/__tests__/discovery.refusal.component.test.tsx', mentions: 'DOES NOT CACHE a refused body' }],
    partial: 'n/a — nothing rendered',
    partialBranches: [],
  },
  // The badge row: the SERVICE omits a refused category (absent key), and the
  // row renders an absent count as no count — never as a dimmed zero.
  'app/(tabs)/discovery.tsx': {
    uses: ['getDiscoveryCategoryCounts'],
    branches: ['const isEmpty = !countsLoading && count !== undefined && count === 0;'],
    proofs: [{ file: 'src/services/__tests__/discovery.refusal.component.test.tsx', mentions: 'OMITS a refused category rather than reporting it as a real zero' }],
    partial: 'n/a — a count badge, not a list: the service omits a failed category and the badge renders an absent key as no count',
    partialBranches: [],
  },
};

// ── Derivation ────────────────────────────────────────────────────────────────

/** Exported functions of the service, each with its source text up to the next top-level export. */
function exportedFunctions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^export (?:async )?function (\w+)\s*[<(]/gm;
  const hits = [...src.matchAll(re)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : src.length;
    out.set(m[1]!, src.slice(m.index!, end));
  });
  return out;
}

/** Interfaces / type aliases in the service that declare a `refusal` member. */
function refusalTypes(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export (?:interface (\w+)[^{]*\{|type (\w+)\s*=)([\s\S]*?)^(?:\}|\S)/gm)) {
    if (/\brefusal\??:/.test(m[3] ?? '')) names.add((m[1] ?? m[2])!);
  }
  return names;
}

function derivedCarriers(): string[] {
  const src = read(SERVICE);
  const types = refusalTypes(src);
  const carriers: string[] = [];
  for (const [name, body] of exportedFunctions(src)) {
    const signature = body.slice(0, body.indexOf('{', body.indexOf(')')));
    const parses = /\b(parseRefusal|withParsedRefusal|refusedEverything)\(|withParsedRefusal</.test(body);
    const returnsOne = [...types].some((t) => new RegExp(`\\b${t}\\b`).test(signature));
    if ((parses || returnsOne) && name !== 'parseRefusal' && name !== 'refusedEverything') carriers.push(name);
  }
  return carriers.sort();
}

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (entry === 'node_modules' || entry === '__tests__' || entry === '__mocks__' || entry === '__fixtures__') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

/** Resolve an import specifier to a repo-relative module path (relative and `@/` specifiers only). */
function resolveSpec(fromFile: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith('.')) p = join(dirname(fromFile), spec);
  else if (spec.startsWith('@/')) p = spec.slice(2);
  else return null;
  p = p.split(sep).join('/');
  for (const cand of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`]) {
    if (existsSync(join(ROOT, cand)) && statSync(join(ROOT, cand)).isFile()) return cand;
  }
  return p;
}

/**
 * The names `file` VALUE-imports from the module at `target` (type-only imports
 * carry no answer). A `require()` / awaited `import()` of it counts as `<dynamic>`:
 * the guard cannot see what is used, so it must be registered and reasoned about.
 */
function valueImports(file: string, src: string, target: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1] || resolveSpec(file, m[3]!) !== target) continue;
    for (const part of m[2]!.split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      names.push(t.split(/\s+as\s+/)[0]!.trim());
    }
  }
  for (const m of src.matchAll(/(?:\brequire|\bawait\s+import)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (resolveSpec(file, m[1]!) === target) names.push('<dynamic>');
  }
  return names;
}

function derivedConsumers(carriers: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of [...walk('src', []), ...walk('app', [])]) {
    if (file === SERVICE) continue;
    const src = read(file);
    const used = new Set<string>();
    for (const n of valueImports(file, src, SERVICE)) if (n === '<dynamic>' || carriers.includes(n)) used.add(n);
    for (const [mod, names] of Object.entries(EXTRA_CARRIERS)) {
      if (file === mod) continue;
      for (const n of valueImports(file, src, mod)) if (names.includes(n)) used.add(n);
    }
    for (const [hook, hookFile] of Object.entries(WRAPPERS)) {
      if (file === hookFile) continue;
      for (const n of valueImports(file, src, hookFile)) if (n === hook || n === '<dynamic>') used.add(hook);
    }
    if (used.size > 0) found.set(file, [...used].sort());
  }
  return found;
}

// ── The guard ─────────────────────────────────────────────────────────────────

describe('DV-83 — every refusal-carrying Discovery read has an accounted consumer', () => {
  const carriers = derivedCarriers();
  const consumers = derivedConsumers(carriers);

  it('G1. the carriers derived from services/discovery.ts are exactly the pinned set', () => {
    assert.deepEqual(carriers, EXPECTED_CARRIERS,
      'the set of Discovery reads that can answer with a refusal changed — pin it here AND register every consumer of the new one in CONSUMERS');
  });

  it('G2. every file that consumes a carrier (directly or through a forwarding hook) is registered', () => {
    const unregistered = [...consumers.keys()].filter((f) => !(f in CONSUMERS));
    assert.deepEqual(unregistered, [],
      `unregistered consumer(s) of a refusal-carrying Discovery read: ${unregistered.map((f) => `${f} (${consumers.get(f)!.join(', ')})`).join('; ')}. ` +
      'Branch on `refusal.coverage` (not on `ok` alone), never cache a `coverage: "nothing"` body, never render one as an empty result — then register the file here with its branch and its proof suite.');
  });

  it('G3. no registry entry is stale: each file exists and imports exactly what it claims', () => {
    for (const [file, c] of Object.entries(CONSUMERS)) {
      assert.ok(existsSync(join(ROOT, file)), `${file} is registered but does not exist`);
      assert.deepEqual(consumers.get(file) ?? [], [...c.uses].sort(), `${file}: registered uses differ from what it imports`);
    }
  });

  it('G4. each consumer still takes its refusal branch', () => {
    for (const [file, c] of Object.entries(CONSUMERS)) {
      const src = read(file);
      for (const b of c.branches) assert.ok(src.includes(b), `${file}: the refusal branch is gone — expected to find:\n  ${b}`);
    }
  });

  it('G5. each consumer\'s branch is proved by a refusal suite that exists', () => {
    for (const [file, c] of Object.entries(CONSUMERS)) {
      assert.ok(c.proofs.length > 0, `${file}: no proof suite`);
      for (const p of c.proofs) {
        assert.ok(existsSync(join(ROOT, p.file)), `${file}: proof suite ${p.file} does not exist`);
        const text = read(p.file);
        assert.ok(text.includes(p.mentions), `${file}: ${p.file} no longer contains "${p.mentions}"`);
        assert.ok(/refus/i.test(text), `${file}: ${p.file} is not a refusal suite`);
      }
      assert.ok(c.partial.length > 0, `${file}: state what a partial answer does here`);
    }
  });

  it('G6. the census count: census-discovery §60 records ELEVEN consumer files — if this moves, so must the census', () => {
    assert.equal(consumers.size, 11, `measured ${consumers.size}: ${[...consumers.keys()].join(', ')}`);
    assert.equal(Object.keys(CONSUMERS).length, 11);
  });

  it('G7. §80: every consumer that renders a list says "incomplete" — the branch is present; the rest say why not', () => {
    for (const [file, c] of Object.entries(CONSUMERS)) {
      const src = read(file);
      if (c.partialBranches.length === 0) {
        assert.match(c.partial, /^n\/a — /, `${file}: no partial branch, and no stated reason the rule does not reach it`);
        continue;
      }
      for (const b of c.partialBranches) assert.ok(src.includes(b), `${file}: the partial branch is gone — expected to find:\n  ${b}`);
    }
    const na = Object.entries(CONSUMERS).filter(([, c]) => c.partialBranches.length === 0).map(([f]) => f).sort();
    assert.deepEqual(na, ['app/(tabs)/_layout.tsx', 'app/(tabs)/discovery.tsx', 'src/components/discovery/DiscoveryEventPostsRail.tsx'],
      'the set of consumers the partial rule does not reach changed — say why here, and in census-discovery');
  });

  it('G8. §80: the ratified wording has one home, and its text is pinned', async () => {
    const n = await import('../discoveryCoverageNotice.ts');
    assert.equal(n.SEARCH_PARTIAL_NOTICE, 'These results are incomplete — part of the search couldn’t be run.');
    assert.equal(n.SEARCH_PARTIAL_EMPTY_TITLE, 'Some of this search could not run.');
    assert.equal(n.listPartialNotice('places'), 'Some places couldn’t be loaded just now, so this list may be incomplete.');
    assert.equal(n.listPartialEmptyTitle('places'), 'Some places couldn’t be loaded just now');
    assert.equal(n.LIST_PARTIAL_EMPTY_BODY, 'This is on our side, not your filters. Try again in a moment.');
    // Every rendering consumer takes its sentence from that module, not from a
    // literal of its own.
    for (const file of [
      'src/components/discovery/ForYouTab.tsx', 'src/components/discovery/DiscoveryCategoryTab.tsx',
      'src/components/search/SearchSuggestionsPanel.tsx', 'src/components/map/MapSearchSheet.tsx',
      'app/search.tsx', 'app/map/index.tsx',
    ]) {
      assert.match(read(file), /from '[./]+(?:src\/)?services\/discoveryCoverageNotice(?:\.ts)?'/, `${file} does not import the ratified wording`);
    }
  });
});

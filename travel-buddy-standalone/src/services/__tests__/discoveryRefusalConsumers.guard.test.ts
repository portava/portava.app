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
const read = (rel: string) => overlayRead(rel) ?? readFileSync(join(ROOT, rel), 'utf8');  // §110 (D-W11X2-99): G10's in-memory fixtures first (none outside G10)

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
  'src/platform/input-assistance/services/inputAssistance.ts': ['requestMapSearchPage'], ...derivedExtraCarriers(),  // census-discovery §109 (D-W11X2-87): GET /compass/recommendations' and GET /hashtags/trending's carriers, derived from their modules (see the file's foot)
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
      "setSavedIdsUnavailable(res.reason !== 'signed_out');", 'if (!osm.ok) return prev;', "const loadErrorShown = source === 'none' && !osmPartial && loadFailed !== null;", '{community.unavailable && !community.refused && (',  // census-discovery §100 (D-W11X2-22/26): a transport failure keeps what is on screen and is its own state, in both lanes
    ],
    proofs: [
      { file: 'src/components/discovery/__tests__/ForYouTab.refusal.component.test.tsx', mentions: 'for-you-community-refused' },
      { file: 'src/components/discovery/__tests__/ForYouTab.refusal.component.test.tsx', mentions: 'for-you-partial' }, { file: 'src/components/discovery/__tests__/ForYouTab.failedRead.component.test.tsx', mentions: 'T3 cached PARTIAL page, failed refetch' }, { file: 'src/components/discovery/__tests__/ForYouTab.failedRead.component.test.tsx', mentions: 'M1 map, refused' },  // §100
    ],
    partial: 'rows kept, one "may be incomplete" line per lane; no rows is never "No recommendations yet"',
    partialBranches: [
      "{source === 'osm' && osmPartial && (",
      "{source === 'none' && osmPartial && (",
      '{community.incomplete && !community.refused && (', "source === 'osm' && osmPartial ? 'partial' : source === 'none' && osmPartial ? 'partial-empty' : null;",  // §100 (D-W11X2-24): map mode states the same coverage over the map
    ],
  },
  'src/components/discovery/DiscoveryCategoryTab.tsx': {
    uses: ['getCachedDiscoveryPlaces', 'getDiscoveryPlaces'],
    branches: [
      "if (nextPage === 1 && res.data.refusal?.coverage === 'nothing') {",
      "if (res.data.refusal?.coverage === 'nothing') {\n      setMoreRefused(true);", "<CategoryMapCoverage kind={error && places.length === 0 ? 'error'", 'setMoreFailed(nextPage > 1);', '!error && !partial && total > 0 && places.length >= total && places.length > 0 ?', 'setTotal(cachedResult.total);',  // §100 (D-W11X2-24): the map branch draws the error state too; §101 (D-W11X2-29/30): a failed load-more is said, and the end claim needs a read that did not fail, no partial page and a known total
    ],
    proofs: [
      { file: 'src/components/discovery/__tests__/DiscoveryCategoryTab.refusal.component.test.tsx', mentions: 'does NOT tell the user to adjust their filters' },
      { file: 'src/components/discovery/__tests__/DiscoveryCategoryTab.loadMoreRefusal.component.test.tsx', mentions: 'a refused page 2 is not the last page' }, { file: 'src/components/discovery/__tests__/DiscoveryCategoryTab.failedRead.component.test.tsx', mentions: 'D1 map, refused' }, { file: 'src/components/discovery/__tests__/DiscoveryCategoryTab.endClaim.component.test.tsx', mentions: 'E4 a failed load-more' },  // §100; §101
    ],
    partial: 'rows kept under a "may be incomplete" line; no rows is the partial-empty state with a retry, never "No places found"',
    partialBranches: ['ListHeaderComponent={partial ?', ') : places.length === 0 && partial ? (', "places.length === 0 && partial ? 'partial-empty' : partial ? 'partial' : null"],  // §100: and over the map
  },
  'src/components/discovery/DiscoveryEventPostsRail.tsx': {
    uses: ['getDiscoveryFeed'],
    branches: ["setRefused(res.data.refusal?.coverage === 'nothing');", 'if (refused) {'],
    proofs: [{ file: 'src/components/discovery/__tests__/DiscoveryEventPostsRail.refusal.component.test.tsx', mentions: 'discovery-event-posts-rail-refused' }, { file: 'src/components/discovery/__tests__/DiscoveryEventPostsRail.coverage.component.test.tsx', mentions: 'discovery-event-posts-rail-partial' }],
    partial: 'census-discovery §94 (hunk §80.7): the feed names "event_posts" in failedSources when their read failed; posts kept under a "may be incomplete" line, no posts is the partial-empty state, and a partial naming only place categories does not describe this rail',
    partialBranches: ["(res.data.refusal.failedSources ?? []).includes('event_posts')", '{postsIncomplete && (', 'if (postsIncomplete && posts.length === 0) {'],
  },
  'src/hooks/useCommunityDiscovery.ts': {
    uses: ['getCommunityPlaces'],
    branches: ["const refused = result.data.refusal?.coverage === 'nothing';", 'if (cKey && !refused && isCurrentDiscoveryScope(scope)) {', 'setState((prev) => ({ ...prev, loading: false, unavailable: true }));', 'const sameCity = heldCityRef.current === commCityOf(c);'],  // §100 (D-W11X2-26): a transport failure is said, never a quiet city; §101 (D-W11X2-32): nor another city's rows
    proofs: [{ file: 'src/hooks/__tests__/useCommunityDiscovery.refusal.component.test.tsx', mentions: 'refused' }, { file: 'src/hooks/__tests__/useCommunityDiscovery.failedRead.component.test.tsx', mentions: 'F1 first read fails in transport' }, { file: 'src/hooks/__tests__/useCommunityDiscovery.citySwitch.component.test.tsx', mentions: 'CS1 city A answered' }],
    partial: 'rows kept and cached WITH `incomplete`, so a cached replay still says so',
    partialBranches: ["incomplete: result.data.refusal?.coverage === 'partial'"],
  },
  'src/hooks/useSearchSuggestions.ts': {
    uses: ['getSearchSuggestions'],
    branches: ["const refusedNow = res.refusal?.coverage === 'nothing';", 'setLoading(false); setRefused(true); setIncomplete(false);'],  // §100 (D-W11X2-26): the transport arm says so too
    proofs: [{ file: 'src/hooks/__tests__/useSearchSuggestions.refusal.component.test.tsx', mentions: 'refused' }, { file: 'src/hooks/__tests__/useSearchSuggestions.failedRead.component.test.tsx', mentions: 'S1 transport failure with nothing on screen' }],
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
    uses: ['searchUnified', 'useGlobalSearchSuggestions', 'fetchCompassRecommendations'],  // §109: and the Compass rail
    branches: ["if (res.data.refusal?.coverage === 'nothing') {", 'refused: suggestRefused,', 'refused={suggestRefused}', '} else setMoreFailed(true);', 'testID="search-more-failed"', 'const rFailed = !cr.ok || !cr.data || compassRecommendationsFailed(cr.data);'],  // §101 (D-W11X2-30): a refused or failed cursor page is said; §109 (D-W11X2-87): the Compass rail's shared predicate
    proofs: [{ file: 'app/__tests__/search.refusal.component.test.tsx', mentions: 'refus' }, { file: 'app/__tests__/search.loadMore.component.test.tsx', mentions: 'SP2 page 2 REFUSED' }, { file: 'app/__tests__/search.compassRailFailed.component.test.tsx', mentions: 'CR2 the rail read is refused' }],
    partial: 'rows rendered with the "incomplete" notice; the suggestions panel says it too',
    partialBranches: ['{SEARCH_PARTIAL_NOTICE}', 'incomplete={suggestIncomplete}', "} else { if (res.data.refusal?.coverage === 'partial') {", "cr.data?.refusal?.coverage === 'partial' ? 'partial' : null);"],  // §101 (D-W11X2-28): a partial cursor page too; §109: the Compass rail
  },
  'src/components/map/MapSearchSheet.tsx': {
    uses: ['requestMapSearchPage'],
    branches: ["const allRefusedEverything = allRefusal?.coverage === 'nothing';", "const savedFailed = res.savedRefusal?.coverage === 'nothing';"],
    proofs: [{ file: 'src/components/map/__tests__/MapSearchSheet.refusal.component.test.tsx', mentions: 'refus' }],
    partial: 'rows rendered with the "incomplete" notice, per lane',
    partialBranches: ["const allPartial = allRefusal?.coverage === 'partial';", 'const NOTICE_PARTIAL = SEARCH_PARTIAL_NOTICE;'],
  },
  'app/map/index.tsx': {
    uses: ['getDiscoveryPlaces', 'fetchCompassRecommendations'],  // §109: and the trip's Compass alternatives
    branches: ["if (res.ok && (res.data?.refusal?.coverage === 'nothing' || isPartialEmpty(res.data?.refusal, res.data?.places))) {", 'compassRecommendations: tripCompassRecommendations(compassRes),'],  // §108 (D-W11X2-81)
    proofs: [{ file: 'app/map/__tests__/projectedPlaces.component.test.tsx', mentions: 'a refusal is not a zero-results map' }, { file: 'app/map/__tests__/tripCompassAlternativesRead.component.test.tsx', mentions: 'TM2 a refused' }],
    partial: 'pins drawn under a "may be incomplete" banner; no places is the retryable error card, never the zero-results state',
    partialBranches: ['isPartialEmpty(res.data?.refusal, res.data?.places)', 'testID="map-places-partial"', "listPartialNotice('Compass alternatives')"],  // §108: the trip's Compass alternatives
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
    uses: ['getDiscoveryCategoryCounts', 'getTrendingHashtags'],  // §109 (D-W11X2-87): and the trending chips
    branches: ['const isEmpty = !countsLoading && count !== undefined && count === 0;', "if (res.ok && res.data && coverage !== 'failed')", 'testID="discovery-trending-failed"'],  // §108 (D-W11X2-79): a refused trending read is the failed line
    proofs: [{ file: 'src/services/__tests__/discovery.refusal.component.test.tsx', mentions: 'OMITS a refused category rather than reporting it as a real zero' }, { file: 'src/services/__tests__/discovery.refusal.component.test.tsx', mentions: 'OMITS a PARTIAL zero' }, { file: 'app/(tabs)/__tests__/discovery.trendingPartial.component.test.tsx', mentions: 'TP2 a `nothing` refusal' }],
    partial: 'the badge: census-discovery §100 (D-W11X2-23) — the service omits a failed, refused OR partial category (a partial total counts only the sources that answered), and the badge renders an absent key as no count, never dimmed; the trending chips (§108, D-W11X2-79): chips kept under "Trending tags may be incomplete right now."',
    partialBranches: ["setTrendingPartial(coverage === 'partial'); }", 'testID="discovery-trending-partial"'],
  }, ...compassRecommendationsConsumers(),  // census-discovery §109 (D-W11X2-87): the /compass/recommendations consumers outside the files above (see the file's foot)
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
  else if (baseUrlModule(spec) !== null) p = baseUrlModule(spec)!; else return null;  // §111 (D-W11X2-116): a baseUrl (".") specifier resolves from the app root
  p = p.split(sep).join('/');
  for (const cand of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`]) {
    if (overlayHas(cand) || (existsSync(join(ROOT, cand)) && statSync(join(ROOT, cand)).isFile())) return cand;
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
  for (const m of stripComments(src).matchAll(/import\s+(type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {  // §111 (D-W11X2-116): a comment inside the braces is not part of a name; §112: a default before the braces too
    if (m[1] || resolveSpec(file, m[3]!) !== target) continue;
    for (const part of m[2]!.split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      names.push(t.split(/\s+as\s+/)[0]!.trim());
    }
  }
  for (const m of stripComments(src).matchAll(/(?:\brequire|\bawait\s+import)\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)) {  // §112 (D-W11X2-126): a template-literal specifier too
    if (resolveSpec(file, m[1]!) === target) names.push('<dynamic>');
  }
  return [...names.filter((n) => n !== '<dynamic>'), ...requireUses(file, src, target), ...otherImportForms(file, src, target)];  // §110 (D-W11X2-99): a namespace import and every dynamic import, read for the names they use
}

function derivedConsumers(carriers: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of withOverlay(clientSources())) {  // §112 (D-W11X2-126): every client source root the app bundles, not src/ and app/ alone
    if (file === SERVICE) continue;
    const src = read(file);
    const used = new Set<string>();
    for (const n of valueImports(file, src, SERVICE)) if (n === '<dynamic>' || carriers.includes(n)) used.add(n);
    for (const [mod, names] of Object.entries(EXTRA_CARRIERS)) {
      if (file === mod) continue;
      for (const n of valueImports(file, src, mod)) if (names.includes(n) || n === '<dynamic>') used.add(n);  // §110 (D-W11X2-99): an unresolvable dynamic import of a carrier module is a use
    }
    for (const [hook, hookFile] of Object.entries(WRAPPERS)) {
      if (file === hookFile) continue;
      for (const n of valueImports(file, src, hookFile)) if (n === hook || n === '<dynamic>') used.add(hook);
    }
    for (const n of reexportedCarrierUses(file, src, carriers)) used.add(n); if (used.size > 0) found.set(file, [...used].sort());  // §110 (D-W11X2-99): through a module that re-exports a carrier
  }
  return found;
}

// ── The guard ─────────────────────────────────────────────────────────────────

describe('DV-83 — every refusal-carrying Discovery read has an accounted consumer', () => {
  const carriers = derivedCarriers();
  const consumers = derivedConsumers(carriers);

  it('G1. the carriers derived from services/discovery.ts are exactly the pinned set', () => {
    assert.deepEqual(carriers, EXPECTED_CARRIERS, 'the set of Discovery reads that can answer with a refusal changed — pin it here AND register every consumer of the new one in CONSUMERS'); assert.deepEqual(derivedExtraCarriers(), expectedExtraCarriers(),  // §109 (D-W11X2-87): and the Compass recommendations and trending carriers
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

  it('G6. the census count: census-discovery §60 records ELEVEN consumer files, §109 SIXTEEN (D-W11X2-87) — if this moves, so must the census', () => {
    assert.equal(consumers.size, 16, `measured ${consumers.size}: ${[...consumers.keys()].join(', ')}`);
    assert.equal(Object.keys(CONSUMERS).length, 16);
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
    assert.deepEqual(na, ['app/(tabs)/_layout.tsx'],  // §94: the rail left this set once the feed named its own failed source; §109: discovery.tsx left it with the trending chips (D-W11X2-87)
      'the set of consumers the partial rule does not reach changed — say why here, and in census-discovery');
  });

  it('G8. §80: the ratified wording has one home, and its text is pinned', async () => {
    const n = await import('../discoveryCoverageNotice.ts');
    assert.equal(n.SEARCH_PARTIAL_NOTICE, 'These results are incomplete — part of the search couldn’t be run.');
    assert.equal(n.SEARCH_PARTIAL_EMPTY_TITLE, 'Some of this search could not run.');
    assert.equal(n.listPartialNotice('places'), 'Some places couldn’t be loaded just now, so this list may be incomplete.');
    assert.equal(n.listPartialEmptyTitle('places'), 'Some places couldn’t be loaded just now');
    assert.equal(n.LIST_PARTIAL_EMPTY_BODY, 'This is on our side, not your filters. Try again in a moment.'); assert.equal(n.listMoreFailedNotice('places'), 'Couldn’t load more places just now.');  // §101 (D-W11X2-30)
    // Every rendering consumer takes its sentence from that module, not from a
    // literal of its own.
    for (const file of [
      'src/components/discovery/ForYouTab.tsx', 'src/components/discovery/DiscoveryCategoryTab.tsx', 'src/components/discovery/DiscoveryEventPostsRail.tsx',
      'src/components/search/SearchSuggestionsPanel.tsx', 'src/components/map/MapSearchSheet.tsx',
      'app/search.tsx', 'app/map/index.tsx',
      'src/components/TripPage.tsx', 'src/components/compass/CompassPassportSuggestions.tsx', 'src/components/compass/CompassBuddyRow.tsx', 'src/components/compass/CompassTravelerRow.tsx',  // §109 (D-W11X2-87)
    ]) {
      assert.match(read(file), /from '[./]+(?:src\/)?services\/discoveryCoverageNotice(?:\.ts)?'/, `${file} does not import the ratified wording`);
    }
  });

  it('G9. §109: every consumer of a Compass recommendations or trending carrier branches through the shared predicate', () => {
    compassConsumersBranchOnCoverage();
  });
});

// ── census-discovery §109 (DV-83 round 12, lane W11-X2, D-W11X2-87): the carriers outside services/discovery.ts ──
//
// §109.1 BK1: this guard derived its carriers from services/discovery.ts alone, so the trip page's
// Compass Brief — a GET /compass/recommendations consumer that never branched on coverage — was
// invisible to it, and D-W11X2-82's "every consumer reads through the predicate" was a list, not a
// check. The carriers of GET /compass/recommendations (services/compass.ts) and of GET
// /hashtags/trending (services/hashtag.ts) are now DERIVED from their modules and pinned (G1); every
// file that value-imports one must be registered (G2), and G9 checks that each such consumer
// branches through the shared predicate, so a new consumer that skips it fails here even once
// registered. Declarations only: they are hoisted, so the registry lines above call them without
// moving a line another census cites.

/** services/compass.ts: the exported functions that read GET /compass/recommendations, directly or through another. */
function compassRecommendationsCarriers(): string[] {
  const fns = exportedFunctions(read('src/services/compass.ts'));
  const found = new Set<string>();
  for (const [name, body] of fns) if (body.includes('/api/compass/recommendations')) found.add(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of fns) {
      if (!found.has(name) && [...found].some((c) => new RegExp(`\\b${c}\\(`).test(body))) { found.add(name); grew = true; }
    }
  }
  return [...found].sort();
}

/** services/hashtag.ts: the exported functions whose answer declares a `refusal`. */
function hashtagRefusalCarriers(): string[] {
  return [...exportedFunctions(read('src/services/hashtag.ts'))].filter(([, body]) => /\brefusal\??:/.test(body)).map(([name]) => name).sort();
}

function derivedExtraCarriers(): Record<string, string[]> {
  return { 'src/services/compass.ts': compassRecommendationsCarriers(), 'src/services/hashtag.ts': hashtagRefusalCarriers() };
}

/** The pin. A change here is a change to DV-83's scope: register the new carrier's consumers too. */
function expectedExtraCarriers(): Record<string, string[]> {
  return {
    'src/services/compass.ts': ['fetchCompassBuddyMatches', 'fetchCompassRecommendations', 'fetchCompassTravelerMatches', 'fetchCompassTripBrief'],
    'src/services/hashtag.ts': ['getTrendingHashtags'],
  };
}

/** Carriers that hand the route's body on as it came: the consumer must branch through the predicate itself. */
const RAW_COMPASS_CARRIERS = ['fetchCompassRecommendations', 'fetchCompassTripBrief'];
/** Carriers whose service already reads the body through `compassMatchesFromBody` (ok: false on a failed read, `partial` beside rows). */
const MATCHES_COMPASS_CARRIERS = ['fetchCompassBuddyMatches', 'fetchCompassTravelerMatches'];

/** The /compass/recommendations consumers that are not also Discovery consumers above. */
function compassRecommendationsConsumers(): Record<string, Consumer> {
  return {
    'src/components/TripPage.tsx': {
      uses: ['fetchCompassTripBrief'],
      branches: ['if (cancelled) return; setReadState(tripCompassReadState(res)); setItems(tripCompassRecommendations(res));', "!loading && readState === 'failed' ? (<View style={cb.loadingRow} testID=\"compass-brief-failed\">", '&& readState === null) return null;'],
      proofs: [{ file: 'src/components/__tests__/CompassTripBrief.failedRead.component.test.tsx', mentions: 'V11-TB1 refused `nothing`' }, { file: 'src/components/__tests__/CompassTripBrief.failedRead.component.test.tsx', mentions: 'V11-TB4 a stale answer' }],
      partial: 'the rows that were read (the static safety note included) under the shared "may be incomplete" line; a failed or refused read is the failed line with Retry, never the hidden brief',
      partialBranches: ["readState === 'partial' ? (<Text style={cb.attentionNote} testID=\"compass-brief-partial\">{listPartialNotice('recommendations')}"],
    },
    'src/components/map/AskCompassBar.tsx': {
      uses: ['fetchCompassRecommendations'],
      branches: ['if (!res.ok || !res.data || compassRecommendationsFailed(res.data)) {'],
      proofs: [{ file: 'src/components/map/__tests__/AskCompassBar.refusal.component.test.tsx', mentions: 'A1 refused `nothing`' }],
      partial: 'the rows are handed up as markers, with "Some Compass suggestions couldn\'t load" on the bar',
      partialBranches: ["if (res.data.refusal?.coverage === 'partial') setErrorMsg(\"Some Compass suggestions couldn't load\");"],
    },
    'src/components/compass/CompassPassportSuggestions.tsx': {
      uses: ['fetchCompassRecommendations'],
      branches: ["if (!res.ok || !res.data || compassRecommendationsFailed(res.data)) { setReadState('failed'); return; }"],
      proofs: [{ file: 'src/components/compass/__tests__/CompassPassportSuggestions.refusal.component.test.tsx', mentions: 'PS2 refused `nothing`' }],
      partial: 'rows kept under the shared "may be incomplete" line',
      partialBranches: ["if (res.data.refusal?.coverage === 'partial') setReadState('partial');", "listPartialNotice('suggestions')"],
    },
    'src/components/compass/CompassBuddyRow.tsx': {
      uses: ['fetchCompassBuddyMatches'],
      branches: ["setReadState(!res.ok ? 'failed' : (!res.disabled && res.partial) ? 'partial' : null);", 'if (items.length === 0 && readState === null) return null;'],
      proofs: [{ file: 'src/components/compass/__tests__/CompassBuddyRow.failedRead.component.test.tsx', mentions: 'BR1b a refused `nothing` read' }],
      partial: 'picks kept under the shared "may be incomplete" line',
      partialBranches: ["listPartialNotice('buddies')"],
    },
    'src/components/compass/CompassTravelerRow.tsx': {
      uses: ['fetchCompassTravelerMatches'],
      branches: ["setReadState(!res.ok ? 'failed' : (!res.disabled && res.partial) ? 'partial' : null);", 'if (items.length === 0 && readState === null) return null;'],
      proofs: [{ file: 'src/components/compass/__tests__/CompassTravelerRow.failedRead.component.test.tsx', mentions: 'T3 refused `nothing`' }],
      partial: 'travelers kept under the shared "may be incomplete" line',
      partialBranches: ["listPartialNotice('travelers')"],
    },
  };
}

/** G9: the branch each derived consumer must take, by the kind of carrier it reads. */
function compassConsumersBranchOnCoverage(): void {
  const svc = exportedFunctions(read('src/services/compass.ts'));
  for (const m of MATCHES_COMPASS_CARRIERS) {
    assert.match(svc.get(m) ?? '', /\bcompassMatchesFromBody</, `${m} no longer reads the route's body through compassMatchesFromBody — its consumers would see a refusal as ok`);
  }
  const consumers = derivedConsumers(derivedCarriers());
  const seen = { raw: 0, matches: 0, trending: 0 };
  for (const [file, used] of consumers) {
    const src = read(file);
    if (used.some((u) => RAW_COMPASS_CARRIERS.includes(u))) {
      seen.raw++;
      assertEachRawSiteBranches(file, src); assert.match(src, /\b(?:compassRecommendationsFailed|tripCompassRecommendations|tripCompassReadState)\(/,  // §110 (D-W11X2-99): every call site, not once per file
        `${file} reads GET /compass/recommendations without the shared predicate: branch through compassRecommendationsFailed (or tripCompassRecommendations / tripCompassReadState), never on \`ok\` alone`);
    }
    if (used.some((u) => MATCHES_COMPASS_CARRIERS.includes(u))) {
      seen.matches++;
      assert.match(src, /!res\.ok \? 'failed'/, `${file}: a failed Compass matches read must be its own state`);
      assert.match(src, /\bres\.partial\b/, `${file}: a partial Compass matches read must be said`);
    }
    if (used.includes('getTrendingHashtags')) {
      seen.trending++;
      assert.match(src, /\.refusal\b/, `${file} reads GET /hashtags/trending without reading its refusal`);
    }
  }
  assert.deepEqual(seen, { raw: 5, matches: 2, trending: 1 }, `the Compass and trending consumers moved: ${JSON.stringify(seen)} — register them, and say so in census-discovery`);
}

// ── census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-99): the guard's reach ────────────────────
//
// The round-12 verifier made four consumers the derivation could not see (GH1–GH4): a namespace import of
// services/compass.ts, an import through a module that re-exports the carrier, an awaited dynamic import,
// and a second raw call site appended to an already-registered file (G9 looked for the predicate once per
// FILE). G10 runs the verifier's fixtures — and a control, and the forms next to them — through the SAME
// derivation, over an in-memory overlay that is never written to disk. Declarations only (hoisted), so the
// registry lines above call them without moving a line another census cites.

/** G10's in-memory files, keyed by repo-relative path. Empty outside G10. */
function overlayMap(): Map<string, string> {
  const holder = overlayMap as unknown as { files?: Map<string, string> };
  return (holder.files ??= new Map());
}
function overlayRead(rel: string): string | undefined { return overlayMap().get(rel); }
function overlayHas(rel: string): boolean { return overlayMap().has(rel); }
function withOverlay(files: string[]): string[] { return [...new Set([...files, ...[...overlayMap().keys()].filter(walkedRoot)])]; }  // §112 (D-W11X2-126): an overlay file is seen only where the walk reads the disk

/** Run `fn` with `files` laid over the tree. */
function withFiles<T>(files: Record<string, string>, fn: () => T): T {
  const m = overlayMap();
  for (const [k, v] of Object.entries(files)) m.set(k, v);
  try { return fn(); } finally { m.clear(); }
}

/** The verifier's fixtures (scratchpad v12-probes/guard-holes), and the forms next to them. */
const GH = {
  named: "import { fetchCompassRecommendations } from '../services/compass.ts';\nexport async function zzRawRecs0(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  namespace: "import * as compass from '../services/compass.ts';\nexport async function zzRawRecs(): Promise<number> {\n  const res = await compass.fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  reexport: "export { fetchCompassRecommendations as zzRecs } from './compass.ts';\n",
  viaReexport: "import { zzRecs } from '../services/zzCompassReexport.ts';\nexport async function zzRawRecs2(): Promise<number> {\n  const res = await zzRecs({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  dynamic: "export async function zzRawRecs3(): Promise<number> {\n  const { fetchCompassRecommendations } = await import('../services/compass.ts');\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  dynamicThen: "export function zzRawRecs5(): Promise<number> {\n  return import('../services/compass.ts').then((m) => m.fetchCompassRecommendations({ surface: 'passport' })).then((res) => (res.ok && res.data ? res.data.recommendations.length : 0));\n}\n",
  starReexport: "export * from './compass.ts';\n",
  viaStar: "import { fetchCompassTripBrief } from '../services/zzCompassStar.ts';\nexport async function zzRawRecs6(): Promise<number> {\n  const res = await fetchCompassTripBrief({ tripId: 't' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  dynamicOpaque: "export async function zzRawRecs7(run: (m: unknown) => Promise<number>): Promise<number> {\n  const loaded = await import('../services/compass.ts');\n  return run(loaded);\n}\n",
  typeOnly: "export function zzTitle(item: import('../services/compass.ts').CompassFeedItem): string {\n  return String((item as { title?: unknown }).title ?? '');\n}\n",
  secondRawSite: "\nexport async function zzSecondRawSite(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
};
const unregisteredNow = (): Map<string, string[]> => new Map([...derivedConsumers(derivedCarriers())].filter(([f]) => !(f in CONSUMERS)));

describe("DV-83 guard reach — the round-12 verifier's fixtures (§110, D-W11X2-99)", () => {
  it('G10 GH0 CONTROL: a raw consumer through a NAMED import is caught', () => {
    const u = withFiles({ 'src/components/zzGH0.tsx': GH.named }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH0.tsx'), ['fetchCompassRecommendations']);
  });
  it('G10 GH1: through a NAMESPACE import is caught, as the carrier it calls', () => {
    const u = withFiles({ 'src/components/zzGH1.tsx': GH.namespace }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH1.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
  });
  it('G10 GH2: through a RE-EXPORT module is caught, as the carrier it re-exports', () => {
    const u = withFiles({ 'src/services/zzCompassReexport.ts': GH.reexport, 'src/components/zzGH2.tsx': GH.viaReexport }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH2.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
  });
  it('G10 GH3: through an awaited DYNAMIC import is caught, as the carrier it destructures', () => {
    const u = withFiles({ 'src/components/zzGH3.tsx': GH.dynamic }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH3.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
  });
  it('G10 GH3b: a dynamic import read through .then, and an export-star re-export, are caught too', () => {
    const u = withFiles({ 'src/components/zzGH5.tsx': GH.dynamicThen, 'src/services/zzCompassStar.ts': GH.starReexport, 'src/components/zzGH6.tsx': GH.viaStar }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH5.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
    assert.deepEqual(u.get('src/components/zzGH6.tsx'), ['fetchCompassTripBrief'], JSON.stringify([...u]));
  });
  it('G10 GH3c: a dynamic import whose names cannot be told is still a use of the carrier module', () => {
    const u = withFiles({ 'src/components/zzGH7.tsx': GH.dynamicOpaque }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH7.tsx'), ['<dynamic>'], JSON.stringify([...u]));
  });
  it('G10 GHc CONTROL: a TYPE read through an inline import is not a consumer', () => {
    const u = withFiles({ 'src/components/zzGHc.tsx': GH.typeOnly }, unregisteredNow);
    assert.equal(u.has('src/components/zzGHc.tsx'), false, JSON.stringify([...u]));
  });
  it('G10 GH4: a second raw call site in a registered consumer fails G9 — every site must branch through the predicate', () => {
    const file = 'src/components/compass/CompassPassportSuggestions.tsx';
    const real = read(file);
    assert.doesNotThrow(() => compassConsumersBranchOnCoverage(), 'the tree as it is passes G9');
    assert.throws(() => withFiles({ [file]: real + GH.secondRawSite }, () => compassConsumersBranchOnCoverage()), /call site|every site|without the shared predicate/i);
  });
});

/** Source with comments removed (a carrier named in a comment is not a use). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}
function escapeRe(x: string): string { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** The keys of a destructuring pattern: `{ a, b: c }` → a, b. */
function patternKeys(pattern: string): string[] { return pattern.split(',').map((p) => p.split(':')[0]!.trim()).filter((p) => /^\w+$/.test(p)); }

/**
 * The names `file` takes from `target` in the forms the named-import regex cannot read: a namespace
 * import (its `ns.member` uses), and every dynamic `import()` — destructured, bound, read through
 * `.then`, or a member of it. `<dynamic>` when the names cannot be told, which counts as a use.
 */
function otherImportForms(file: string, src: string, target: string): string[] {
  const code = stripComments(src);
  const names: string[] = [];
  const membersOf = (binding: string) => [...code.matchAll(new RegExp(`\\b${escapeRe(binding)}\\s*\\.\\s*(\\w+)`, 'g'))].map((m) => m[1]!);
  for (const m of code.matchAll(/import\s+(?:\w+\s*,\s*)?\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g)) {  // §112 (D-W11X2-126): a default before the namespace too
    if (resolveSpec(file, m[2]!) !== target) continue;
    const used = [...membersOf(m[1]!), ...destructuredFrom(code, m[1]!)];  // §111 (D-W11X2-116): a carrier destructured from the namespace is used
    names.push(...(used.length > 0 ? used : ['<dynamic>']));
  }
  for (const m of code.matchAll(/\bimport\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)) {  // §112 (D-W11X2-126): a template-literal specifier too
    if (resolveSpec(file, m[1]!) !== target) continue;
    const before = code.slice(Math.max(0, m.index! - 200), m.index!);
    const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
    const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?\(?\s*(?:await\s+)?$/.exec(before);
    const bound = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?$/.exec(before);
    const member = /^\s*\)?\s*\.\s*(\w+)/.exec(after);
    const thenArg = /^\s*\.then\(\s*(?:async\s*)?\(?\s*(?:\{([^}]*)\}|(\w+))/.exec(after);
    const found = destructured ? patternKeys(destructured[1]!)
      : bound ? membersOf(bound[1]!)
      : thenArg ? (thenArg[1] !== undefined ? patternKeys(thenArg[1]) : membersOf(thenArg[2]!))
      : member && member[1] !== 'then' ? [member[1]!]
      : [];
    names.push(...(found.length > 0 ? found : ['<dynamic>']));
  }
  return names;
}

/** The carrier modules and the carriers each exports: services/discovery.ts, EXTRA_CARRIERS, the wrapper hooks. */
function carrierModules(carriers: string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>([[SERVICE, new Map(carriers.map((c) => [c, c]))]]);
  for (const [mod, names] of Object.entries(EXTRA_CARRIERS)) out.set(mod, new Map(names.map((c) => [c, c])));
  for (const [hook, hookFile] of Object.entries(WRAPPERS)) out.set(hookFile, new Map([[hook, hook]]));
  return out;
}

/** Every module that re-exports a carrier, with its exported name → the carrier, chains followed. */
function carrierReexports(carriers: string[]): Map<string, Map<string, string>> {
  const memo = carrierReexports as unknown as { key?: string; value?: Map<string, Map<string, string>> };
  const key = `${carriers.join(',')}|${[...overlayMap()].map(([f, v]) => `${f}:${v.length}`).join(',')}`;
  if (memo.key === key && memo.value) return memo.value;
  memo.value = carrierReexportsUncached(carriers); memo.key = key;
  return memo.value;
}

function carrierReexportsUncached(carriers: string[]): Map<string, Map<string, string>> {
  const known = carrierModules(carriers);
  const out = new Map<string, Map<string, string>>();
  const files = withOverlay(clientSources()).map((f) => [f, stripComments(read(f))] as const);  // §112 (D-W11X2-126)
  for (let grew = true; grew;) {
    grew = false;
    for (const [file, code] of files) {
      if (known.has(file) && !out.has(file)) continue;  // a carrier module's own re-exports are its business
      const add = (exported: string, carrier: string) => {
        const m = out.get(file) ?? new Map<string, string>();
        if (!m.has(exported)) { m.set(exported, carrier); out.set(file, m); known.set(file, m); grew = true; }
      };
      for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const from = known.get(resolveSpec(file, m[2]!) ?? '');
        if (!from) continue;
        for (const part of m[1]!.split(',')) {
          const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((x) => x.trim());
          if (orig && from.has(orig) && !/^type\s/.test(part.trim())) add(alias ?? orig, from.get(orig)!);
        }
      }
      for (const [exported, carrier] of localReexports(file, code, known)) add(exported, carrier); for (const m of code.matchAll(/export\s*\*\s*(?:as\s+(\w+)\s*)?from\s*['"]([^'"]+)['"]/g)) {  // §112 (D-W11X2-126): a local re-export (no `from`) too
        const from = known.get(resolveSpec(file, m[2]!) ?? '');
        if (!from) continue;
        if (m[1]) add(m[1], '<dynamic>');
        else for (const [name, carrier] of from) add(name, carrier);
      }
    }
  }
  return out;
}

/** The carriers `file` reaches through a re-export module (the carrier's own name, so G3 and G9 see it). */
function reexportedCarrierUses(file: string, src: string, carriers: string[]): string[] {
  const used: string[] = [];
  for (const [mod, names] of carrierReexports(carriers)) {
    if (file === mod) continue;
    for (const n of valueImports(file, src, mod)) {
      if (names.has(n)) used.push(names.get(n)!);
      else if (n === '<dynamic>') used.push('<dynamic>');
    }
  }
  return used;
}

/** G9, per call site: after EVERY raw Compass read in `file`, before the next, the shared predicate is called. */
function assertEachRawSiteBranches(file: string, src: string): void {
  const code = stripComments(src).replace(/^\s*(?:import|export)\b[^;]*\bfrom\s*['"][^'"]+['"];?/gm, '');
  const locals = new Set<string>(RAW_COMPASS_CARRIERS); const reexports = [...carrierReexports(derivedCarriers()).values()];
  for (const m of stripComments(src).matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {  // §112 (D-W11X2-126)
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (alias && orig && (RAW_COMPASS_CARRIERS.includes(orig) || reexports.some((n) => RAW_COMPASS_CARRIERS.includes(n.get(orig) ?? '')))) locals.add(alias);
      else if (orig && reexports.some((n) => RAW_COMPASS_CARRIERS.includes(n.get(orig) ?? ''))) locals.add(orig);
    }
  }
  for (const a of carrierAliases(code, locals)) locals.add(a); const call = new RegExp(`(?:\\b\\w+\\s*\\.\\s*)?\\b(?:${[...locals].map(escapeRe).join('|')})\\s*(?:\\.\\s*(?:call|apply)\\s*)?\\(`, 'g');  // §111 (D-W11X2-116): a call through an alias or a rename is a site; §112: and through .call / .apply
  const sites = [...code.matchAll(call)].map((m) => m.index!).filter((i) => !/\bfunction\s+$/.test(code.slice(Math.max(0, i - 30), i)));
  const predicate = /\b(?:compassRecommendationsFailed|tripCompassRecommendations|tripCompassReadState)\(/;
  sites.forEach((at, k) => {
    const window = code.slice(at, sites[k + 1] ?? code.length);
    assert.match(window, predicate, `${file}: a GET /compass/recommendations call site at offset ${at} reads the body without the shared predicate — every site must branch through compassRecommendationsFailed (or tripCompassRecommendations / tripCompassReadState)`);
  });
}

/** A `require()` of `target`: the guard cannot see what is used, so it is `<dynamic>`. */
function requireUses(file: string, src: string, target: string): string[] {
  return [...stripComments(src).matchAll(/\brequire\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)].filter((m) => resolveSpec(file, m[1]!) === target).map(() => '<dynamic>');
}

// ── census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-116): the guard's reach, round 13's holes ─────────
//
// The round-13 verifier made five raw consumers the derivation or G9 could not see (GH5–GH9): a named import with
// a line comment inside its braces (a form the tree uses), a baseUrl specifier (tsconfig `baseUrl: "."`), a carrier
// destructured from a namespace import, and — in two registered files — a second raw site called through a local
// alias and through a RENAMED dynamic destructure. D-W11X2-99's "sees every import form and every raw call site" was
// not honest. The fixtures run through the same derivation and G9 over the in-memory overlay; declarations only, at
// the file's foot, so no line another census cites moves.
const GH13 = {
  braceComment: "import {\n  // Compass picks for the passport rail\n  fetchCompassRecommendations,\n} from '../services/compass.ts';\nexport async function zzRawRecsGH5(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  baseUrl: "import { fetchCompassRecommendations } from 'src/services/compass';\nexport async function zzRawRecsGH6(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  nsDestructure: "import * as compass from '../services/compass.ts';\nconst { fetchCompassRecommendations } = compass;\nexport async function zzRawRecsGH7(): Promise<number> {\n  void compass.fetchCompassWhy;\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  aliasSite: "\n// GH8 (v13 verifier): a second raw site in a registered consumer, called through a local alias.\nexport async function zzAliasSiteGH8(): Promise<number> {\n  const load = fetchCompassRecommendations;\n  const res = await load({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  dynRename: "\n// GH9 (v13 verifier): a second raw site in a registered consumer, through a RENAMED dynamic destructure.\nexport async function zzDynRenameGH9(): Promise<number> {\n  const { fetchCompassRecommendations: recs } = await import('../../services/compass.ts');\n  const res = await recs({ surface: 'map', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  aliasBranches: "\nexport async function zzAliasBranches(): Promise<number> {\n  const load = fetchCompassRecommendations;\n  const res = await load({ surface: 'passport', limit: 3 });\n  if (!res.ok || !res.data || compassRecommendationsFailed(res.data)) return -1;\n  return res.data.recommendations.length;\n}\n",
  packageSpec: "import { useState } from 'react';\nexport function zzPkg(): number { const [n] = useState(0); return n; }\n",
};

describe("DV-83 guard reach — the round-13 verifier's fixtures (§111, D-W11X2-116)", () => {
  it('G11 GH5: a named import with a line comment inside its braces is caught', () => {
    const u = withFiles({ 'src/components/zzGH5b.tsx': GH13.braceComment }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH5b.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
  });
  it('G11 GH6: an import through a baseUrl specifier is caught', () => {
    const u = withFiles({ 'src/components/zzGH6b.tsx': GH13.baseUrl }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH6b.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
  });
  it('G11 GH6c CONTROL: a package specifier resolves to nothing and makes no consumer', () => {
    const u = withFiles({ 'src/components/zzGH6c.tsx': GH13.packageSpec }, unregisteredNow);
    assert.equal(u.has('src/components/zzGH6c.tsx'), false, JSON.stringify([...u]));
  });
  it('G11 GH7: a carrier destructured from a namespace import is caught', () => {
    const u = withFiles({ 'src/components/zzGH7b.tsx': GH13.nsDestructure }, unregisteredNow);
    assert.deepEqual(u.get('src/components/zzGH7b.tsx'), ['fetchCompassRecommendations'], JSON.stringify([...u]));
  });
  it('G11 GH8: a second raw site called through a local alias fails G9', () => {
    const file = 'src/components/compass/CompassPassportSuggestions.tsx';
    assert.throws(() => withFiles({ [file]: read(file) + GH13.aliasSite }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
  });
  it('G11 GH9: a second raw site through a renamed dynamic destructure fails G9', () => {
    const file = 'src/components/map/AskCompassBar.tsx';
    assert.throws(() => withFiles({ [file]: read(file) + GH13.dynRename }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
  });
  it('G11 GH8c CONTROL: an aliased site that branches through the predicate passes G9', () => {
    const file = 'src/components/compass/CompassPassportSuggestions.tsx';
    assert.doesNotThrow(() => withFiles({ [file]: read(file) + GH13.aliasBranches }, () => compassConsumersBranchOnCoverage()));
  });
});

/** A baseUrl specifier (tsconfig `baseUrl: "."`): the module under the app root it names, or null (a package). */
function baseUrlModule(spec: string): string | null {
  if (spec.startsWith('/') || spec.startsWith('@')) return null;
  for (const cand of [spec, `${spec}.ts`, `${spec}.tsx`, `${spec}/index.ts`]) {
    if (overlayHas(cand) || (existsSync(join(ROOT, cand)) && statSync(join(ROOT, cand)).isFile())) return spec;
  }
  return null;
}

/** The keys destructured from `binding`: `const { a, b: c } = binding` → a, b. */
function destructuredFrom(code: string, binding: string): string[] {
  return [...code.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${escapeRe(binding)}\\b(?!\\s*\\.)`, 'g'))].flatMap((m) => patternKeys(m[1]!));
}

/**
 * The local names a raw carrier is reached through besides its own: `const x = carrier`, `const x = ns.carrier`,
 * and a renamed destructure `{ carrier: x } = …` (of a namespace, a dynamic import or anything else), followed to
 * a fixpoint so an alias of an alias is one too.
 */
function carrierAliases(code: string, names: Set<string>): string[] {
  const found = new Set<string>(names);
  for (let grew = true; grew;) {
    grew = false;
    const add = (x: string | undefined) => { if (x && /^\w+$/.test(x) && !found.has(x)) { found.add(x); grew = true; } };
    for (const n of [...found]) {
      for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?(?:\\w+\\s*\\.\\s*)?${escapeRe(n)}\\b(?!\\s*[.(])`, 'g'))) add(m[1]);
      // §112 (D-W11X2-126): an object property that holds the carrier (`{ key: carrier }`, called `obj.key(…)`), and a bound copy.
      for (const m of code.matchAll(new RegExp(`[{,]\\s*(\\w+)\\s*:\\s*(?:\\w+\\s*\\.\\s*)?${escapeRe(n)}\\b(?!\\s*[.(:])`, 'g'))) add(m[1]);
      for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:\\w+\\s*\\.\\s*)?${escapeRe(n)}\\s*\\.\\s*bind\\s*\\(`, 'g'))) add(m[1]);
      for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
        for (const part of m[1]!.split(',')) {
          const [key, alias] = part.split(':').map((x) => x.trim());
          if (key === n && alias) add(alias);
        }
      }
    }
  }
  return [...found].filter((x) => !names.has(x));
}

// ── census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-126): the guard's reach, round 14's holes ──────────
//
// The round-14 verifier made six consumers the guard could not see (GH10–GH15): a raw consumer in the app's ROOT
// components/ directory (the walk read only src/ and app/), a template-literal dynamic import, a local re-export from a
// registered file, a second raw site called through `.call` and through an object-property alias, and a second call site
// of a services/discovery.ts carrier in a registered file (G4 checks a branch per FILE; G9's per-site check reached only
// the Compass carriers). D-W11X2-116's reach was not the whole of it. The fixtures are the verifier's, verbatim; each runs
// through the WHOLE guard (every derivation and every per-site check) over the in-memory overlay, which lays a file only
// where the walk reads the disk. Declarations only, at the file's foot, so no line another census cites moves.
const GH14V = {
  rootComponents: "// GH10 (v14 verifier): a raw consumer in the app's ROOT components/ directory (live code: app/_layout.tsx imports '@/components/ErrorBoundary'); the guard walks only src/ and app/.\nimport { fetchCompassRecommendations } from '../src/services/compass.ts';\nexport async function zzRawRecsGH10(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  backtickDynamic: "// GH11 (v14 verifier): an awaited dynamic import whose specifier is a template literal (no substitution).\nexport async function zzRawRecsGH11(): Promise<number> {\n  const { fetchCompassRecommendations } = await import(`../services/compass.ts`);\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  localReexport: "\n// GH12 (v14 verifier): a registered consumer re-exports the carrier LOCALLY (no `from`) ...\nexport { fetchCompassRecommendations as zzRecsGH12 };\n",
  viaLocal: "// GH12 (v14 verifier): ... and a new raw consumer imports it from there.\nimport { zzRecsGH12 } from './compass/CompassPassportSuggestions.tsx';\nexport async function zzRawRecsGH12(): Promise<number> {\n  const res = await zzRecsGH12({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  callSite: "\n// GH13 (v14 verifier): a second raw site in a registered consumer, called through Function.prototype.call.\nexport async function zzCallSiteGH13(): Promise<number> {\n  const res = await fetchCompassRecommendations.call(undefined, { surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  applySite: "\n// GH13b: the same site through Function.prototype.apply.\nexport async function zzApplySiteGH13(): Promise<number> {\n  const res = await fetchCompassRecommendations.apply(undefined, [{ surface: 'passport', limit: 3 }]);\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  objectAlias: "\n// GH14 (v14 verifier): a second raw site in a registered consumer, through an object-property alias.\nconst zzApiGH14 = { fetchPicks: fetchCompassRecommendations };\nexport async function zzObjectAliasGH14(): Promise<number> {\n  const res = await zzApiGH14.fetchPicks({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  objectAliasBranches: "\nconst zzApiGH14c = { fetchPicks: fetchCompassRecommendations };\nexport async function zzObjectAliasBranches(): Promise<number> {\n  const res = await zzApiGH14c.fetchPicks({ surface: 'passport', limit: 3 });\n  if (!res.ok || !res.data || compassRecommendationsFailed(res.data)) return -1;\n  return res.data.recommendations.length;\n}\n",
  discoverySecondSite: "\n// GH15 (v14 verifier): a second raw site of a services/discovery.ts carrier in a registered consumer (G4 checks branches per FILE; G9's per-site check covers only the Compass carriers).\nexport async function zzDiscoverySecondSiteGH15(): Promise<number> {\n  const res = await getDiscoveryPlaces('Lisbon', 'food', {} as never, 1);\n  return res.ok ? res.data.places.length : 0;\n}\n",
  defaultPlusNamed: "import React, { fetchCompassRecommendations } from '../services/compass.ts';\nexport async function zzRawRecsGH16(): Promise<number> {\n  void React;\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  computedSpecifier: "const which = 'compass';\nexport async function zzComputedGH11b(): Promise<number> {\n  const m = await import(`../services/${which}.ts`);\n  const res = await m.fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
};

/** Every per-tree check of this file, as one: G2's registration, G3's uses, G9's per-site predicate, and §112's own. */
function wholeGuard(): void {
  const consumers = derivedConsumers(derivedCarriers());
  const unregistered = [...consumers.keys()].filter((f) => !(f in CONSUMERS));
  assert.deepEqual(unregistered, [], `unregistered consumer(s): ${unregistered.map((f) => `${f} (${consumers.get(f)!.join(', ')})`).join('; ')}`);
  for (const [file, c] of Object.entries(CONSUMERS)) assert.deepEqual(consumers.get(file) ?? [], [...c.uses].sort(), `${file}: registered uses differ from what it imports`);
  compassConsumersBranchOnCoverage();
  round15Checks();
}

describe("DV-83 guard reach — the round-14 verifier's fixtures (§112, D-W11X2-126)", () => {
  const PASSPORT = 'src/components/compass/CompassPassportSuggestions.tsx';
  it('G12 the tree as it is passes the whole guard', () => {
    assert.doesNotThrow(() => wholeGuard());
  });
  it('G12 GH10: a raw consumer in the root components/ directory is caught', () => {
    assert.throws(() => withFiles({ 'components/zzGH10.tsx': GH14V.rootComponents }, wholeGuard), /unregistered consumer\(s\): components\/zzGH10\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G12 GH11: a template-literal dynamic import is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH11.tsx': GH14V.backtickDynamic }, wholeGuard), /zzGH11\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G12 GH11b: a dynamic import whose specifier is computed fails — the guard cannot tell what it loads', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH11b.tsx': GH14V.computedSpecifier }, wholeGuard), /zzGH11b\.tsx/);
  });
  it('G12 GH12: a local re-export from a registered file is caught at its importer', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14V.localReexport, 'src/components/zzGH12.tsx': GH14V.viaLocal }, wholeGuard), /zzGH12\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G12 GH13: a second raw site called through .call (or .apply) fails G9', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14V.callSite }, wholeGuard), /call site|without the shared predicate/i);
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14V.applySite }, wholeGuard), /call site|without the shared predicate/i);
  });
  it('G12 GH14: a second raw site through an object-property alias fails G9', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14V.objectAlias }, wholeGuard), /call site|without the shared predicate/i);
  });
  it('G12 GH14c CONTROL: an object-property alias site that branches through the predicate passes G9', () => {
    assert.doesNotThrow(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14V.objectAliasBranches }, () => compassConsumersBranchOnCoverage()));
  });
  it('G12 GH15: a second call site of a services/discovery.ts carrier in a registered file fails', () => {
    const file = 'app/map/index.tsx';
    assert.throws(() => withFiles({ [file]: read(file) + GH14V.discoverySecondSite }, wholeGuard), /call site/i);
  });
  it('G12 GH16: a default-plus-named import of a carrier is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH16.tsx': GH14V.defaultPlusNamed }, wholeGuard), /zzGH16\.tsx \(fetchCompassRecommendations\)/);
  });
});

/**
 * Top-level entries of the app that the bundle never loads, each with why (a function: hoisted, as the suite above runs at load). Every OTHER top-level directory is walked,
 * so a new source root is seen by default; `G12 GH10b` checks that no walked source imports from one of these.
 */
function clientNotBundled(): Record<string, string> {
  return {
  node_modules: 'installed packages',
  scripts: 'Node build and check scripts run by pnpm; the app never imports them',
  server: 'the Node share server (server/serve.js), run by the host beside the bundle',
  e2e: 'Maestro flows',
  plugins: 'Expo config plugins, run at build time',
  docs: 'documentation',
  migrations: 'SQL',
  assets: 'images, fonts and sounds',
  __mocks__: 'jest module mocks',
  };
}

/** The top-level directories the app bundles: every directory not named in clientNotBundled() (dot-directories aside). */
function clientRoots(): string[] {
  return readdirSync(ROOT).filter((e) => !e.startsWith('.') && !(e in clientNotBundled()) && statSync(join(ROOT, e)).isDirectory()).sort();
}

/** Every client source the app can bundle: each client root walked, and the .ts/.tsx files at the app root. */
function clientSources(): string[] {
  const out: string[] = [];
  for (const r of clientRoots()) walk(r, out);
  for (const e of readdirSync(ROOT)) if (/\.(ts|tsx)$/.test(e) && !/\.test\.(ts|tsx)$/.test(e) && statSync(join(ROOT, e)).isFile()) out.push(e);
  return out;
}

/** The directories the overlay lays files in: those the walk reads. */
function walkedRoot(rel: string): boolean {
  return rel.includes('/') ? clientRoots().includes(rel.split('/')[0]!) : /\.(ts|tsx)$/.test(rel);
}

/**
 * A local re-export from `file` (no `from`): `export { carrier as x }`, `export const x = carrier` (or `ns.carrier`),
 * where the local name is a carrier `file` imports from a known carrier or re-export module.
 */
function localReexports(file: string, code: string, known: Map<string, Map<string, string>>): Array<[string, string]> {
  const locals = new Map<string, string>();
  for (const m of code.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const from = known.get(resolveSpec(file, m[2]!) ?? '');
    if (!from) continue;
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (orig && from.has(orig) && !/^type\s/.test(part.trim())) locals.set(alias ?? orig, from.get(orig)!);
    }
  }
  for (const m of code.matchAll(/import\s+(?:\w+\s*,\s*)?\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g)) {
    const from = known.get(resolveSpec(file, m[2]!) ?? '');
    if (from) for (const [name, carrier] of from) locals.set(`${m[1]}.${name}`, carrier);
  }
  const out: Array<[string, string]> = [];
  for (const m of code.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (orig && locals.has(orig)) out.push([alias ?? orig, locals.get(orig)!]);
    }
  }
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+(\w+)\s*=\s*(\w+(?:\s*\.\s*\w+)?)\s*[;\n]/g)) {
    const ref = m[2]!.replace(/\s+/g, '');
    if (locals.has(ref)) out.push([m[1]!, locals.get(ref)!]);
  }
  return out;
}

/** Client sources that load a module by a COMPUTED specifier (`import(x)`, a template with a substitution): the guard cannot tell what they load. */
function computedSpecifiers(): string[] {
  const out: string[] = [];
  for (const file of withOverlay(clientSources())) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/(?<![\w.$])(?:import|require)\(\s*([^)]*)\)/g)) {
      const arg = m[1]!.trim();
      if (!/^(['"])[^'"]*\1$/.test(arg) && !/^`[^`$]*`$/.test(arg)) out.push(`${file}: ${m[0].slice(0, 80)}`);
    }
  }
  return out;
}

/**
 * The call sites of each carrier a registered consumer uses — direct, through a namespace, an alias, a rename, an
 * object property, `.call` or `.apply` — counted per carrier (an alias's sites under its own name).
 */
function carrierSiteCounts(file: string, src: string, uses: string[]): Record<string, number> {
  const code = stripComments(src).replace(/^\s*(?:import|export)\b[^;]*\bfrom\s*['"][^'"]+['"];?/gm, '');
  const locals = new Set<string>(uses.filter((u) => u !== '<dynamic>'));
  for (const m of stripComments(src).matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (orig && alias && locals.has(orig)) locals.add(alias);
    }
  }
  for (const a of carrierAliases(code, locals)) locals.add(a);
  const counts: Record<string, number> = {};
  const call = new RegExp(`(?:\\b\\w+\\s*\\.\\s*)?\\b(${[...locals].map(escapeRe).join('|')})\\s*(?:\\.\\s*(?:call|apply)\\s*)?\\(`, 'g');
  for (const m of code.matchAll(call)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index! - 30), m.index!))) continue;
    counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
  }
  return counts;
}

/**
 * The call sites each registered consumer makes today, pinned. G4 finds a consumer's branch once per FILE, so a new
 * call site — a second read of a carrier in a file that already branches once — must be registered here, beside the
 * branch fragment (G4) and the suite (G5) that cover it. G9 checks each Compass raw site's predicate on its own.
 */
const REGISTERED_SITES: Record<string, Record<string, number>> = {
  'src/components/discovery/ForYouTab.tsx': { getCachedDiscoveryPlaces: 5, getDiscoveryPlaces: 1, getSavedPlaceIds: 1, useCommunityDiscovery: 1 },
  'src/components/discovery/DiscoveryCategoryTab.tsx': { getCachedDiscoveryPlaces: 3, getDiscoveryPlaces: 1 },
  'src/components/discovery/DiscoveryEventPostsRail.tsx': { getDiscoveryFeed: 1 },
  'src/hooks/useCommunityDiscovery.ts': { getCommunityPlaces: 1 },
  'src/hooks/useSearchSuggestions.ts': { getSearchSuggestions: 1 },
  'src/hooks/useGlobalSearchSuggestions.ts': { useSearchSuggestions: 1 },
  'app/search.tsx': { searchUnified: 1, useGlobalSearchSuggestions: 1, fetchCompassRecommendations: 1 },
  'src/components/map/MapSearchSheet.tsx': { requestMapSearchPage: 1 },
  'app/map/index.tsx': { getDiscoveryPlaces: 1, fetchCompassRecommendations: 1 },
  'app/(tabs)/_layout.tsx': { getDiscoveryCategoryCountsBatch: 1, getDiscoveryPlaces: 1 },
  'app/(tabs)/discovery.tsx': { getDiscoveryCategoryCounts: 1, getTrendingHashtags: 1 },
  'src/components/TripPage.tsx': { fetchCompassTripBrief: 1 },
  'src/components/map/AskCompassBar.tsx': { fetchCompassRecommendations: 1 },
  'src/components/compass/CompassPassportSuggestions.tsx': { fetchCompassRecommendations: 1 },
  'src/components/compass/CompassBuddyRow.tsx': { fetchCompassBuddyMatches: 1 },
  'src/components/compass/CompassTravelerRow.tsx': { fetchCompassTravelerMatches: 1 },
};

/** §112's own per-tree checks: no computed specifier, and every carrier call site in a registered consumer is pinned. */
function round15Checks(): void {
  assert.deepEqual(computedSpecifiers(), [], 'a client source loads a module by a computed specifier — the guard cannot tell whether it reads a refusal-carrying Discovery carrier; use a literal specifier');
  for (const [file, c] of Object.entries(CONSUMERS)) {
    assert.deepEqual(carrierSiteCounts(file, read(file), c.uses), REGISTERED_SITES[file] ?? {}, `${file}: a carrier call site was added or removed — every call site of a refusal-carrying read must branch on its coverage; register the new site in REGISTERED_SITES with the branch (G4) and the suite (G5) that prove it`);
  }
}

describe('DV-83 guard reach — the roots and the pins (§112, D-W11X2-126)', () => {
  it('G12 GH10b: the client roots are every top-level directory not named as unbundled, and no walked source imports from an unbundled one', () => {
    assert.deepEqual(clientRoots(), ['app', 'components', 'constants', 'hooks', 'src', 'vendor']);
    const sources = clientSources();
    assert.ok(sources.includes('components/ErrorBoundary.tsx') && sources.includes('hooks/useColors.ts'), 'the root components/ and hooks/ are walked');
    const reach: string[] = [];
    for (const file of sources) {
      for (const m of stripComments(read(file)).matchAll(/(?:\bfrom\s*|\bimport\(\s*|\brequire\(\s*)['"`]([^'"`$]+)['"`]/g)) {
        const target = resolveSpec(file, m[1]!);
        const code = !/\.(?:webp|png|jpe?g|gif|svg|ttf|otf|mp3|wav|mp4|json|lottie)$/i.test(target ?? '');  // an image or a font is not a module that can read a carrier
        if (target && code && target.split('/')[0]! in clientNotBundled() && target.split('/')[0] !== 'node_modules') reach.push(`${file} → ${target}`);
      }
    }
    assert.deepEqual(reach, [], 'a bundled source imports from a directory this guard does not walk');
  });
  it('G12 GH15c CONTROL: a registered file with its sites unchanged passes the pin; one site fewer fails it', () => {
    const file = 'app/(tabs)/discovery.tsx';
    assert.doesNotThrow(() => round15Checks());
    assert.throws(() => withFiles({ [file]: read(file).replace(/getDiscoveryCategoryCounts\(/, 'void (') }, () => round15Checks()), /call site was added or removed/);
  });
});

// §112 (D-W11X2-126): the forms next to the verifier's, each pinning one reading the fixes above added.
const GH14N = {
  unbundled: "import { fetchCompassRecommendations } from '../src/services/compass.ts';\nexport async function zzUnbundledGH10c(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  exportConst: "\nexport const zzRecsGH12b = fetchCompassRecommendations;\n",
  viaExportConst: "import { zzRecsGH12b } from './compass/CompassPassportSuggestions.tsx';\nexport async function zzRawRecsGH12b(): Promise<number> {\n  const res = await zzRecsGH12b({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  nsExport: "\nimport * as zzNsGH12c from '../../services/compass.ts';\nexport const zzNsRecsGH12c = zzNsGH12c.fetchCompassRecommendations;\n",
  viaNsExport: "import { zzNsRecsGH12c } from './compass/CompassPassportSuggestions.tsx';\nexport async function zzRawRecsGH12c(): Promise<number> {\n  const res = await zzNsRecsGH12c({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  boundSite: "\nexport async function zzBoundGH13c(): Promise<number> {\n  const zzBound = fetchCompassRecommendations.bind(null);\n  const res = await zzBound({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  discoveryCallSite: "\nexport async function zzCallGH15b(): Promise<number> {\n  const res = await getDiscoveryPlaces.call(undefined, 'Lisbon', 'food', {} as never, 1);\n  return res.ok ? res.data.places.length : 0;\n}\n",
  discoveryAliasSite: "\nconst zzLoadGH15c = getDiscoveryPlaces;\nexport async function zzAliasGH15c(): Promise<number> {\n  const res = await zzLoadGH15c('Lisbon', 'food', {} as never, 1);\n  return res.ok ? res.data.places.length : 0;\n}\n",
  defaultPlusNamespace: "import React, * as zzCompassGH16b from '../services/compass.ts';\nexport async function zzRawRecsGH16b(): Promise<number> {\n  void React;\n  const res = await zzCompassGH16b.fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  defaultPlusNamedSite: "\nimport zzDefaultGH16c, { fetchCompassRecommendations as zzRecsGH16c } from '../../services/compass.ts';\nexport async function zzSiteGH16c(): Promise<number> {\n  void zzDefaultGH16c;\n  const res = await zzRecsGH16c({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
};

describe('DV-83 guard reach — the forms next to them (§112, D-W11X2-126)', () => {
  const PASSPORT = 'src/components/compass/CompassPassportSuggestions.tsx';
  const MAP = 'app/map/index.tsx';
  it('G12 GH10c CONTROL: a raw consumer in an unbundled directory (scripts/) is not walked and makes no consumer', () => {
    const u = withFiles({ 'scripts/zzGH10c.ts': GH14N.unbundled }, unregisteredNow);
    assert.equal(u.has('scripts/zzGH10c.ts'), false, JSON.stringify([...u]));
  });
  it('G12 GH12b: an `export const x = carrier` re-export from a registered file is caught at its importer', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14N.exportConst, 'src/components/zzGH12b.tsx': GH14N.viaExportConst }, wholeGuard), /zzGH12b\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G12 GH12c: a re-export of a namespace member from a registered file is caught at its importer', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14N.nsExport, 'src/components/zzGH12c.tsx': GH14N.viaNsExport }, wholeGuard), /zzGH12c\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G12 GH13b: G9 alone fails a second raw site called through .call, and one through a bound copy', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14V.callSite }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14N.boundSite }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
  });
  it('G12 GH15b: a second discovery-carrier site through .call, or through an alias, fails the site pin', () => {
    assert.throws(() => withFiles({ [MAP]: read(MAP) + GH14N.discoveryCallSite }, () => round15Checks()), /call site was added or removed/);
    assert.throws(() => withFiles({ [MAP]: read(MAP) + GH14N.discoveryAliasSite }, () => round15Checks()), /call site was added or removed/);
  });
  it('G12 GH16b: a default-plus-namespace import of a carrier module is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH16b.tsx': GH14N.defaultPlusNamespace }, wholeGuard), /zzGH16b\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G12 GH16c: G9 alone fails a raw site reached through a default-plus-named, renamed import', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH14N.defaultPlusNamedSite }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
  });
});

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
import { fileURLToPath } from 'node:url'; import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import ts from 'typescript';  // census-discovery §115 (GH33–GH40): the source is read through the TypeScript parser; GH40 walks a temporary tree

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
  const re = /^export (?:default )?(?:async )?function (\w+)\s*[<(]/gm;  // §113 (D-W11X2-133): a default-exported function too
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

function walk(dir: string, out: string[], root: string = ROOT): string[] {  // §115 (GH40, R8): `root` lets G13 walk a temporary tree
  if (!existsSync(join(root, dir))) return out;
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (walkSkipsDir(entry)) continue;  // §113 (D-W11X2-133): one list of skipped directories, shared with the overlay (isWalkedPath)
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out, root);
    else if (isClientSource(entry)) out.push(rel);  // §113 (D-W11X2-133): .js/.jsx/.mjs/.cjs too (the app bundles .js)
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
  const hit = firstExisting(moduleCandidates(p));  // §113 (D-W11X2-133): every extension, platform variant and index Metro resolves
  if (hit !== null) return hit;
  // No candidate exists: the specifier's own path stands for the module.
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
    if (m[1] || !sameModule(resolveSpec(file, m[3]!), target)) continue;  // §113: one module identity (extension, platform variant, index)
    for (const part of m[2]!.split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      names.push(t.split(/\s+as\s+/)[0]!.trim());
    }
  }
  // census-discovery §116 (GH41–GH44): a require() or import() of `target` is read from the syntax tree (moduleLoads, at the
  // file's foot) by requireUses and otherImportForms below. The regex over the text that stood here pushed a '<dynamic>' the
  // return's filter dropped, so it read nothing; both are gone.
  return [...names, ...requireUses(file, src, target), ...otherImportForms(file, src, target), ...defaultImportUses(file, src, target)];  // §113 (D-W11X2-133): a default import too  // §110 (D-W11X2-99): a namespace import and every dynamic import, read for the names they use
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
function withOverlay(files: string[]): string[] { return [...new Set([...files, ...[...overlayMap().keys()].filter((k) => walkedRoot(k, files) && isWalkedPath(k))])]; }  // §112 (D-W11X2-126): an overlay file is seen only where the caller's walk reads the disk

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

/** Source with comments removed (a carrier named in a comment is not a use), read by the TypeScript parser (§115). */
function stripComments(src: string): string {
  return canonicalSource(src);  // census-discovery §115 (GH33, GH34, GH37, GH38): comments are the parser's, never a `/*` or `//` inside a string; imports and exports are printed in one canonical form
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
    if (!sameModule(resolveSpec(file, m[2]!), target)) continue;
    const used = [...membersOf(m[1]!), ...destructuredFrom(code, m[1]!)];  // §111 (D-W11X2-116): a carrier destructured from the namespace is used
    names.push(...(used.length > 0 ? used : ['<dynamic>']), ...(namespaceHandedOn(src, m[1]!) ? ['<dynamic>'] : []));  // §115 (GH36): a namespace used other than as `ns.member` (spread, passed, stored) hands every member on
  }
  for (const d of moduleLoads(src)) {  // census-discovery §116 (GH41–GH44): every import() from the syntax tree, whatever its spacing, comments or escapes
    if (d.kind !== 'import' || d.spec === null || !sameModule(resolveSpec(file, d.spec), target)) continue;
    let top: ts.Node = d.call;
    while (ts.isParenthesizedExpression(top.parent) || ts.isAwaitExpression(top.parent)) top = top.parent;
    const p = top.parent;
    const keys = (b: ts.BindingName) => (ts.isObjectBindingPattern(b) ? b.elements.filter((e) => !e.dotDotDotToken).map((e) => { const k = e.propertyName ?? e.name; return ts.isIdentifier(k) ? ts.idText(k) : ts.isStringLiteral(k) ? k.text : ''; }).filter((k) => /^\w+$/.test(k)) : null);
    const destructured = ts.isVariableDeclaration(p) && p.initializer === top ? keys(p.name) : null;
    const bound = ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name) ? ts.idText(p.name) : null;
    const member = ts.isPropertyAccessExpression(p) && p.expression === top ? ts.idText(p.name) : null;
    const cb = member === 'then' && ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent.arguments[0] : undefined;
    const param = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters[0]?.name : undefined;
    const found = destructured ?? (bound ? membersOf(bound) : param ? (keys(param) ?? (ts.isIdentifier(param) ? membersOf(ts.idText(param)) : [])) : member && member !== 'then' ? [member] : []);
    names.push(...(found.length > 0 ? found : ['<dynamic>']));
  }
  // (§116: the three text windows that read the import's surroundings are the syntax tree's parents above.)
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
        const from = knownModule(known, resolveSpec(file, m[2]!));  // §113: one module identity
        if (!from) continue;
        for (const part of m[1]!.split(',')) {
          const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((x) => x.trim());
          if (orig && from.has(orig) && !/^type\s/.test(part.trim())) add(alias ?? orig, from.get(orig)!);
        }
      }
      for (const [exported, carrier] of localReexports(file, code, known)) add(exported, carrier); for (const m of code.matchAll(/export\s*\*\s*(?:as\s+(\w+)\s*)?from\s*['"]([^'"]+)['"]/g)) {  // §112 (D-W11X2-126): a local re-export (no `from`) too
        const from = knownModule(known, resolveSpec(file, m[2]!));
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
  for (const d of defaultImportLocals(file, src, RAW_COMPASS_CARRIERS)) locals.add(d); for (const a of carrierAliases(code, locals)) locals.add(a); const call = new RegExp(`(?:\\b\\w+\\s*\\.\\s*)?\\b(?:${[...locals].map(escapeRe).join('|')})\\s*(?:\\.\\s*(?:call|apply)\\s*)?\\(`, 'g');  // §111 (D-W11X2-116): a call through an alias or a rename is a site; §112: and through .call / .apply
  const sites = [...code.matchAll(call)].map((m) => m.index!).filter((i) => !/\bfunction\s+$/.test(code.slice(Math.max(0, i - 30), i)));
  const predicate = /\b(?:compassRecommendationsFailed|tripCompassRecommendations|tripCompassReadState)\(/;
  sites.forEach((at, k) => {
    const window = code.slice(at, sites[k + 1] ?? code.length);
    assert.match(window, predicate, `${file}: a GET /compass/recommendations call site at offset ${at} reads the body without the shared predicate — every site must branch through compassRecommendationsFailed (or tripCompassRecommendations / tripCompassReadState)`);
  });
}

/** A `require()` of `target`: the guard cannot see what is used, so it is `<dynamic>`. */
function requireUses(file: string, src: string, target: string): string[] {
  return moduleLoads(src).filter((d) => d.kind === 'require' && d.spec !== null && sameModule(resolveSpec(file, d.spec), target)).map(() => '<dynamic>');  // census-discovery §116 (GH43): from the syntax tree, `require (x)` too
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
  if (firstExisting(moduleCandidates(spec)) !== null) return spec;  // §113 (D-W11X2-133)
  // A specifier that names no module under the app root is a package.
  //
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
  round15Checks(); round16Checks();  // §113 (D-W11X2-133): and every non-call reference to a carrier is pinned
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

/** Every client source the app can bundle: each client root walked, and the bundled scripts at the app root (rootSources). */
function clientSources(): string[] {
  const out: string[] = [];
  for (const r of clientRoots()) walk(r, out);
  for (const e of rootSources(readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isFile()))) out.push(e);  // §113 (D-W11X2-133): .js too; the root build configs are named as unbundled
  return out;
}

/** Whether the caller's walk reads `rel`'s top-level directory (or, for a root file, the app root): the overlay mirrors the walk. */
function walkedRoot(rel: string, walked: string[]): boolean {
  const top = (f: string) => (f.includes('/') ? f.split('/')[0]! : '');
  return top(rel) === '' || walked.some((f) => top(f) === top(rel));  // §113 (D-W11X2-133): the app root is always read (clientSources), even with no bundled file there today
}

/**
 * A local re-export from `file` (no `from`): `export { carrier as x }`, `export const x = carrier` (or `ns.carrier`),
 * where the local name is a carrier `file` imports from a known carrier or re-export module.
 */
function localReexports(file: string, code: string, known: Map<string, Map<string, string>>): Array<[string, string]> {
  const locals = new Map<string, string>();
  for (const m of code.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const from = knownModule(known, resolveSpec(file, m[2]!));  // §113
    if (!from) continue;
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (orig && from.has(orig) && !/^type\s/.test(part.trim())) locals.set(alias ?? orig, from.get(orig)!);
    }
  }
  for (const m of code.matchAll(/import\s+(?:\w+\s*,\s*)?\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g)) {
    const from = knownModule(known, resolveSpec(file, m[2]!));
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
  for (const m of code.matchAll(/export\s+default\s+(\w+(?:\s*\.\s*\w+)?)\s*[;\n]/g)) { const ref = m[1]!.replace(/\s+/g, ''); if (locals.has(ref)) out.push(['default', locals.get(ref)!]); }  // §113 (D-W11X2-133): `export default carrier`
  return out;
}

/** Client sources that load a module by a COMPUTED specifier (`import(x)`, a template with a substitution): the guard cannot tell what they load. */
function computedSpecifiers(): string[] {
  const out: string[] = [];
  for (const file of withOverlay(clientSources())) {
    const loads = moduleLoads(read(file));  // census-discovery §116 (GH41–GH44): import() and require() from the syntax tree, so `import (x)` and `require (x)` are seen too
    for (const d of loads) {
      if (d.spec !== null) continue;  // a literal specifier: the parser's value, escapes and all
      out.push(`${file}: ${d.text.slice(0, 80)}`);
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
  for (const d of defaultImportLocals(file, src, [...locals])) locals.add(d); for (const a of carrierAliases(code, locals)) locals.add(a);  // §113: a default import's local name too
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
    assert.deepEqual(unbundledReach(sources), [], 'a bundled source imports from a directory this guard does not walk');  // census-discovery §116: the loop is unbundledReach, at the foot
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

// ── census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-133): the guard's reach, round 15's holes ─────────────
//
// The round-15 verifier made seven consumers the guard could not see (GH17–GH23): a raw consumer in a `.js` source (the
// walk read .ts/.tsx only), a re-export through a directory's `index.tsx` (resolution tried `/index.ts` only), a default
// re-export taken by a plain default import (only braces and namespaces were read), and — in registered consumers — a
// second raw site through an array element, an optional call `carrier?.()`, `.then(carrier)` and `Reflect.apply`. Each
// escaped because the guard enumerated FORMS. The fix is structural where it can be: one source predicate shared by the
// walk and the overlay; one module identity for every resolution (extension, platform variant and `index` folded); and,
// in every registered consumer, every reference to a carrier that is not a direct call is counted and pinned
// (`REGISTERED_REFS`), so a new way of reaching a carrier fails whatever its shape. The fixtures are the verifier's,
// verbatim, through the WHOLE guard. Declarations only, at the file's foot, so no line another census cites moves.
const GH15V = {
  jsConsumer: "// GH17 (v15 verifier): a raw consumer in a .js source under a walked root (the tree bundles .js: hooks/useColors.js, components/KeyboardAwareScrollViewCompat.js). walk() reads only .ts/.tsx.\nimport { fetchCompassRecommendations } from '../src/services/compass.ts';\nexport async function zzRawRecsGH17() {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  indexReexport: "// GH18 (v15 verifier): a re-export module that is a directory's index.tsx (Metro resolves './zzGH18' to it; resolveSpec tries only /index.ts).\nexport { fetchCompassRecommendations as zzRecsGH18 } from '../../services/compass.ts';\n",
  viaIndex: "// GH18 (v15 verifier): ... and a raw consumer imports the carrier through the directory.\nimport { zzRecsGH18 } from " + "'./zzGH18';\nexport async function zzRawRecsGH18(): Promise<number> {\n  const res = await zzRecsGH18({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  defaultReexport: "// GH19 (v15 verifier): a re-export module that re-exports the carrier as its DEFAULT export ...\nexport { fetchCompassRecommendations as default } from './compass.ts';\n",
  viaDefault: "// GH19 (v15 verifier): ... and a raw consumer takes it through a plain default import (valueImports reads only braces or a namespace).\nimport zzRecsGH19 from '../services/zzCompassDefaultGH19.ts';\nexport async function zzRawRecsGH19(): Promise<number> {\n  const res = await zzRecsGH19({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  arrayAlias: "\n// GH20 (v15 verifier): a second raw site in a registered consumer, through an array element (no alias form G9 or the site pin reads).\nconst zzLoadersGH20 = [fetchCompassRecommendations];\nexport async function zzArrayAliasGH20(): Promise<number> {\n  const res = await zzLoadersGH20[0]({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  optionalCall: "\n// GH21 (v15 verifier): a second raw site in a registered consumer, called with optional-call syntax.\nexport async function zzOptionalCallGH21(): Promise<number> {\n  const res = await fetchCompassRecommendations?.({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  callbackSite: "\n// GH22 (v15 verifier): a second raw site in a registered consumer, the carrier handed to .then as the callback.\nexport async function zzCallbackGH22(): Promise<number> {\n  const res = await Promise.resolve({ surface: 'passport' as const, limit: 3 }).then(fetchCompassRecommendations);\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  reflectApply: "\n// GH23 (v15 verifier): a second site of a services/discovery.ts carrier in a registered consumer, through Reflect.apply (the site pin counts only name( / .call( / .apply().\nexport async function zzReflectGH23(): Promise<number> {\n  const res = await Reflect.apply(getDiscoveryPlaces, undefined, ['Lisbon', 'food', {} as never, 1]);\n  return res.ok ? res.data.places.length : 0;\n}\n",
};

/** §113: the forms next to the verifier's, each pinning one reading the fixes add. */
const GH15N = {
  localDefault: "import { fetchCompassRecommendations } from './compass.ts';\nexport default fetchCompassRecommendations;\n",
  viaLocalDefault: "import zzRecsGH19b from '../services/zzCompassLocalDefaultGH19b.ts';\nexport async function zzRawRecsGH19b(): Promise<number> {\n  const res = await zzRecsGH19b({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  platformPlain: "export const zzPlainGH18b = 1;\n",
  platformWeb: "export { fetchCompassRecommendations as zzRecsGH18b } from '../../services/compass.ts';\n",
  viaPlatform: "import { zzRecsGH18b } from " + "'./zzGH18b/mod';\nexport async function zzRawRecsGH18b(): Promise<number> {\n  const res = await zzRecsGH18b({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  typeRef: "\nexport type ZzRecsResultGH21c = Awaited<ReturnType<typeof fetchCompassRecommendations>>;\n",
  jsxUnbundledConfig: "const zzScripts = require('./scripts/zzGH17c.js');\nmodule.exports = zzScripts;\n",
};

describe("DV-83 guard reach — the round-15 verifier's fixtures (§113, D-W11X2-133)", () => {
  const PASSPORT = 'src/components/compass/CompassPassportSuggestions.tsx';
  const MAP = 'app/map/index.tsx';
  it('G13 GH17: a raw consumer in a .js source is caught', () => {
    assert.throws(() => withFiles({ 'hooks/zzGH17.js': GH15V.jsConsumer }, wholeGuard), /unregistered consumer\(s\): hooks\/zzGH17\.js \(fetchCompassRecommendations\)/);
  });
  it('G13 GH17b: the walk reads the .js sources the app bundles, and the root build configs are named as unbundled', () => {
    const sources = clientSources();
    for (const f of ['hooks/useColors.js', 'components/KeyboardAwareScrollViewCompat.js', 'constants/colors.js']) assert.ok(sources.includes(f), `${f} is not walked`);
    for (const f of ['babel.config.js', 'metro.config.js', 'jest.config.js']) assert.equal(sources.includes(f), false, `${f} is a build config, not a bundled source`);
  });
  it('G13 GH18: a re-export through a directory index.tsx is caught at its importer', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH18/index.tsx': GH15V.indexReexport, 'src/components/zzGH18use.tsx': GH15V.viaIndex }, wholeGuard), /zzGH18use\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH18b: a re-export in a platform variant (mod.web.tsx beside a plain mod.tsx) is caught at its importer', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH18b/mod.tsx': GH15N.platformPlain, 'src/components/zzGH18b/mod.web.tsx': GH15N.platformWeb, 'src/components/zzGH18buse.tsx': GH15N.viaPlatform }, wholeGuard), /zzGH18buse\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH19: a default re-export taken by a plain default import is caught', () => {
    assert.throws(() => withFiles({ 'src/services/zzCompassDefaultGH19.ts': GH15V.defaultReexport, 'src/components/zzGH19.tsx': GH15V.viaDefault }, wholeGuard), /zzGH19\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH19b: a local `export default carrier` taken by a default import is caught', () => {
    assert.throws(() => withFiles({ 'src/services/zzCompassLocalDefaultGH19b.ts': GH15N.localDefault, 'src/components/zzGH19b.tsx': GH15N.viaLocalDefault }, wholeGuard), /zzGH19b\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH20: a second raw site through an array element fails', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH15V.arrayAlias }, wholeGuard), /non-call reference|call site|shared predicate/i);
  });
  it('G13 GH21: a second raw site through an optional call fails', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH15V.optionalCall }, wholeGuard), /non-call reference|call site|shared predicate/i);
  });
  it('G13 GH22: the carrier handed to .then as the callback fails', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH15V.callbackSite }, wholeGuard), /non-call reference|call site|shared predicate/i);
  });
  it('G13 GH23: a second discovery-carrier site through Reflect.apply fails', () => {
    assert.throws(() => withFiles({ [MAP]: read(MAP) + GH15V.reflectApply }, wholeGuard), /non-call reference|call site/i);
  });
  it('G13 GH21c CONTROL: a type read through `typeof carrier` in a registered file is not a reference that reads it', () => {
    assert.doesNotThrow(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH15N.typeRef }, wholeGuard));
  });
  it('G13 the tree as it is: every registered consumer reaches its carriers only by direct calls (REGISTERED_REFS)', () => {
    assert.doesNotThrow(() => wholeGuard());
  });
});

/** §113 (D-W11X2-133): a source file the app can bundle — every script extension Metro reads, tests aside. The walk and the overlay share it. */
function isClientSource(name: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !metroBlocks(`/${name}`);  // §114: a test file is what Metro's blockList says it is
}

/** The app root's own files the bundle never loads, each with why: they run in the build and test tools, not in the app. */
function clientRootFilesNotBundled(): Record<string, string> {
  return {
    'babel.config.js': 'the Babel config, read by the bundler at build time',
    'metro.config.js': 'the Metro config, read by the bundler at build time',
    'jest.config.js': 'the jest config for the component suites',
    'jest.web.config.js': 'the jest config for the web suites',
  };
}

/** Whether the walk reads `rel`: a client source, and — at the app root — not a named build config. */
function isWalkedPath(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return isClientSource(name) && !rel.split('/').slice(0, -1).some(walkSkipsDir) && (rel.includes('/') || !(rel in clientRootFilesNotBundled()));
}

/** What Metro may resolve a specifier path to: the path, every source extension and platform variant, then the same under `index`. */
function moduleCandidates(p: string): string[] {
  const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
  const platforms = ['', '.native', '.ios', '.android', '.web'];
  const out = [p];
  for (const pl of platforms) for (const e of exts) out.push(`${p}${pl}.${e}`);
  for (const pl of platforms) for (const e of exts) out.push(`${p}/index${pl}.${e}`);
  return out;
}

/**
 * One module identity: extension and platform variant folded away, so `x.tsx` and `x.web.tsx` are one module (Metro loads
 * one or the other by platform, and each may re-export differently). A directory's `index` is reached through
 * moduleCandidates. Folding can only make two paths the same module, so it can add a consumer, never lose one.
 */
function moduleId(p: string): string {
  return p.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '').replace(/\.(?:native|ios|android|web)$/, '');
}
function sameModule(resolved: string | null, target: string): boolean {
  return resolved !== null && moduleId(resolved) === moduleId(target);
}
function knownModule<T>(known: Map<string, T>, resolved: string | null): T | undefined {
  if (resolved === null) return undefined;
  const direct = known.get(resolved);
  if (direct !== undefined) return direct;
  const id = moduleId(resolved);
  for (const [k, v] of known) if (moduleId(k) === id) return v;
  return undefined;
}

/** The default imports in `src`: `import X from '…'` and `import X, { … } | * as ns from '…'` (`import type X` never matches: `type` is followed by a name, not `from`). */
function defaultImports(src: string): Array<{ local: string; spec: string }> {
  return [...stripComments(src).matchAll(/import\s+(\w+)\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+\w+)\s*)?from\s*['"]([^'"]+)['"]/g)].map((m) => ({ local: m[1]!, spec: m[2]! }));
}

/** The name a carrier module's own source exports as its default: `export default x`, `export { x as default }` or `export default function x`. */
function ownDefaultExport(module: string): string | null {
  let code: string;
  try { code = stripComments(read(module)); } catch { return null; }
  const m = /export\s+default\s+(?:async\s+)?(?:function\s+)?(\w+)/.exec(code) ?? /export\s*\{[^}]*?\b(\w+)\s+as\s+default\b[^}]*\}(?!\s*from)/.exec(code);
  return m ? m[1]! : null;
}

/** §113: the name `file` takes from `target` through a default import — the module's own default, or `default` (a re-export module maps it). */
function defaultImportUses(file: string, src: string, target: string): string[] {
  // Both names: a carrier module's own default is read by its name, a re-export module's by `default` (each derivation keeps the one it knows).
  return defaultImports(src).filter((d) => sameModule(resolveSpec(file, d.spec), target)).flatMap(() => [...new Set([ownDefaultExport(target) ?? 'default', 'default'])]);
}

/** §113: the local names of default imports that bind one of `wanted` (a carrier module's default, or a re-export module's). */
function defaultImportLocals(file: string, src: string, wanted: string[]): string[] {
  const carriers = derivedCarriers();
  const out: string[] = [];
  for (const d of defaultImports(src)) {
    const resolved = resolveSpec(file, d.spec);
    const own = [...carrierModules(carriers).keys()].find((k) => sameModule(resolved, k));
    const carrier = own ? ownDefaultExport(own) : knownModule(carrierReexports(carriers), resolved)?.get('default') ?? null;
    if (carrier && wanted.includes(carrier)) out.push(d.local);
  }
  return out;
}

/**
 * §113 (D-W11X2-133): every reference to a carrier in `file` that is NOT a direct call — handed on as a value, stored in an
 * array or an object, called optionally, applied through `Reflect`, aliased. The per-site checks see a call; a carrier
 * reached any other way reads its answer somewhere they do not look. A type read (`typeof carrier`) is not a reference that
 * reads it, and neither is the carrier's own declaration.
 */
function carrierNonCallRefs(file: string, src: string, uses: string[]): string[] {
  const code = stripComments(src).replace(/^\s*(?:import|export)\b[^;]*\bfrom\s*['"][^'"]+['"];?/gm, '');
  const locals = new Set<string>(uses.filter((u) => u !== '<dynamic>'));
  for (const m of stripComments(src).matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (orig && alias && locals.has(orig)) locals.add(alias);
    }
  }
  for (const d of defaultImportLocals(file, src, [...locals])) locals.add(d);
  const refs: string[] = [];
  for (const name of locals) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, 'g'))) {
      const at = m.index!;
      const before = code.slice(Math.max(0, at - 30), at);
      const after = code.slice(at + name.length, at + name.length + 60);
      if (/^\s*\(/.test(after) || /^\s*<[^<>()]*>\s*\(/.test(after)) continue;  // a direct (or generic) call
      if (/\b(?:function|typeof)\s+$/.test(before)) continue;                   // its declaration, or a type read
      refs.push(`${name}: …${code.slice(Math.max(0, at - 24), at + name.length + 24).replace(/\s+/g, ' ')}…`);
    }
  }
  return refs.sort();
}

/** The non-call references each registered consumer makes today, by carrier, pinned. Empty: every consumer calls its carriers directly. */
function registeredRefs(): Record<string, Record<string, number>> {
  return {};
}

/** §113's own per-tree check: every non-call reference to a carrier in a registered consumer is pinned. */
function round16Checks(): void {
  for (const [file, c] of Object.entries(CONSUMERS)) {
    const refs = carrierNonCallRefs(file, read(file), c.uses);
    const counts: Record<string, number> = {};
    for (const r of refs) { const n = r.slice(0, r.indexOf(':')); counts[n] = (counts[n] ?? 0) + 1; }
    assert.deepEqual(counts, registeredRefs()[file] ?? {}, `${file}: a carrier is reached by a non-call reference (${refs.join(' | ')}) — handed on, stored, aliased or called indirectly it escapes the per-site checks; call it directly where its coverage is branched on, or register the reference in registeredRefs() with the branch (G4) and the suite (G5) that prove it`);
  }
}

/** §113: the first candidate that exists — in the overlay (never cached), or on disk (cached: the tree does not change during a run). */
function firstExisting(cands: string[]): string | null {
  for (const c of cands) if (overlayHas(c)) return c;
  const cache = firstExisting as unknown as { disk?: Map<string, string | null> };
  const disk = (cache.disk ??= new Map());
  const key = cands[0]!;
  if (!disk.has(key)) disk.set(key, cands.find((c) => existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()) ?? null);
  return disk.get(key)!;
}

// §113 (D-W11X2-133): the forms that make each reading load-bearing — a baseUrl specifier resolves through the candidates
// alone, a platform variant through the module identity, and a default import or default export through its own reading.
const GH15B = {
  rootConfig: "import { fetchCompassRecommendations } from './src/services/compass.ts';\nexport const zzCfg = fetchCompassRecommendations;\n",
  jsReexport: "export { fetchCompassRecommendations as zzRecsGH17e } from '../services/compass.ts';\n",
  viaBaseUrlJs: "import { zzRecsGH17e } from 'src/components/zzGH17e';\nexport async function zzRawRecsGH17e(): Promise<number> {\n  const res = await zzRecsGH17e({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  indexReexport: "export { fetchCompassRecommendations as zzRecsGH18d } from '../../services/compass.ts';\n",
  viaBaseUrlIndex: "import { zzRecsGH18d } from 'src/components/zzGH18d';\nexport async function zzRawRecsGH18d(): Promise<number> {\n  const res = await zzRecsGH18d({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  platformOnly: "export { fetchCompassRecommendations as zzRecsGH18e } from '../../services/compass.ts';\n",
  viaBaseUrlPlatform: "import { zzRecsGH18e } from 'src/components/zzGH18e/mod';\nexport async function zzRawRecsGH18e(): Promise<number> {\n  const res = await zzRecsGH18e({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  defaultCarrierFn: "\nexport default async function zzDefaultCarrierGH19c(): Promise<{ refusal?: unknown }> {\n  return withParsedRefusal({} as never) as never;\n}\n",
  compassOwnDefault: "\nexport default fetchCompassRecommendations;\n",
  viaCompassDefault: "import zzOwnDefaultGH19e from '../services/compass.ts';\nexport async function zzRawRecsGH19e(): Promise<number> {\n  const res = await zzOwnDefaultGH19e({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  passportDefaultValue: "\nimport zzDefGH20b from '../../services/zzCompassDefaultGH19.ts';\nexport const zzArrGH20b = [zzDefGH20b];\n",
  passportDefaultCall: "\nimport zzDefGH20c from '../../services/zzCompassDefaultGH19.ts';\nexport async function zzDefCallGH20c(): Promise<number> {\n  const res = await zzDefGH20c({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  discoveryDefault: "export { getDiscoveryPlaces as default } from './discovery.ts';\n",
  mapDefaultCall: "\nimport zzPlacesGH23b from '../../src/services/zzDiscoveryDefaultGH23b.ts';\nexport async function zzDefaultSiteGH23b(): Promise<number> {\n  const res = await zzPlacesGH23b('Lisbon', 'food', {} as never, 1);\n  return res.ok ? res.data.places.length : 0;\n}\n",
};

describe('DV-83 guard reach — the readings made load-bearing (§113, D-W11X2-133)', () => {
  const PASSPORT = 'src/components/compass/CompassPassportSuggestions.tsx';
  const MAP = 'app/map/index.tsx';
  it('G13 GH17c CONTROL: a root build config is not walked, on disk or in memory — it makes no consumer', () => {
    const u = withFiles({ 'babel.config.js': GH15B.rootConfig }, unregisteredNow);
    assert.equal(u.has('babel.config.js'), false, JSON.stringify([...u]));
  });
  it('G13 GH17e: a .js re-export module reached by a baseUrl specifier is caught at its importer', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH17e.js': GH15B.jsReexport, 'src/components/zzGH17euse.tsx': GH15B.viaBaseUrlJs }, wholeGuard), /zzGH17euse\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH18d: a directory index reached by a baseUrl specifier is caught at its importer', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH18d/index.tsx': GH15B.indexReexport, 'src/components/zzGH18duse.tsx': GH15B.viaBaseUrlIndex }, wholeGuard), /zzGH18duse\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH18e: a platform-only module reached by a baseUrl specifier is caught at its importer', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH18e/mod.web.tsx': GH15B.platformOnly, 'src/components/zzGH18euse.tsx': GH15B.viaBaseUrlPlatform }, wholeGuard), /zzGH18euse\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH19c: a default-exported function of services/discovery.ts that reads a refusal is a carrier', () => {
    const carriers = withFiles({ [SERVICE]: read(SERVICE) + GH15B.defaultCarrierFn }, () => derivedCarriers());
    assert.ok(carriers.includes('zzDefaultCarrierGH19c'), JSON.stringify(carriers));
  });
  it("G13 GH19e: a carrier module's own default export, taken by a default import, is caught", () => {
    assert.throws(() => withFiles({ 'src/services/compass.ts': read('src/services/compass.ts') + GH15B.compassOwnDefault, 'src/components/zzGH19e.tsx': GH15B.viaCompassDefault }, wholeGuard), /zzGH19e\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH20b: a default-imported carrier handed on as a value in a registered consumer fails the reference pin', () => {
    assert.throws(() => withFiles({ 'src/services/zzCompassDefaultGH19.ts': GH15V.defaultReexport, [PASSPORT]: read(PASSPORT) + GH15B.passportDefaultValue }, () => round16Checks()), /non-call reference/);
  });
  it('G13 GH20c: G9 alone fails a raw site reached through a default import', () => {
    assert.throws(() => withFiles({ 'src/services/zzCompassDefaultGH19.ts': GH15V.defaultReexport, [PASSPORT]: read(PASSPORT) + GH15B.passportDefaultCall }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
  });
  it('G13 GH23b: a second discovery-carrier site through a default import fails the site pin', () => {
    assert.throws(() => withFiles({ 'src/services/zzDiscoveryDefaultGH23b.ts': GH15B.discoveryDefault, [MAP]: read(MAP) + GH15B.mapDefaultCall }, () => round15Checks()), /call site was added or removed/);
  });
});

// §113 (D-W11X2-133): the overlay mirrors the walk's skipped directories too — a file under __tests__, __mocks__ or
// __fixtures__ is never walked on disk, so a fixture placed there must not be seen in memory (GR4 found the overlay did).
const GH15D = {
  nested: GH.named.replace("'../services/compass.ts'", "'../../services/compass.ts'"),
  platformPlain: "export const zzPlainGH18f = 1;\n",
  platformWeb: "export { fetchCompassRecommendations as zzRecsGH18f } from '../../services/compass.ts';\n",
  rootConsumer: GH.named.replace("'../services/compass.ts'", "'./src/services/compass.ts'"),
  ownDefaultBraces: "\nexport { fetchCompassRecommendations as default };\n",
  viaOwnDefaultBraces: "import zzOwnDefaultGH19f from " + "'../services/compass.ts';\nexport async function zzRawRecsGH19f(): Promise<number> {\n  const res = await zzOwnDefaultGH19f({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  barrel: "export { zzRecsGH18f } from " + "'./zzGH18f/mod';\n",
  viaBarrel: "import { zzRecsGH18f } from " + "'./zzGH18fbarrel';\nexport async function zzRawRecsGH18f(): Promise<number> {\n  const res = await zzRecsGH18f({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
};

describe('DV-83 guard reach — the overlay mirrors the walk\'s skipped directories (§113, D-W11X2-133)', () => {
  it('G13 GH17f CONTROL: a raw consumer under __tests__, or named .test, is not walked, on disk or in memory; one under __mocks__ or __fixtures__ IS, as Metro bundles it (§114, GH25/GH27/GH28)', () => {
    const files = { 'src/components/__tests__/zzGH17f.tsx': GH15D.nested, 'src/components/zzGH17f.test.tsx': GH.named }; const bundled = { 'src/components/__mocks__/zzGH17f.tsx': GH15D.nested, 'src/components/__fixtures__/zzGH17f.tsx': GH15D.nested };
    const u = withFiles({ ...files, ...bundled }, unregisteredNow);
    for (const f of Object.keys(files)) assert.equal(u.has(f), false, `${f} is seen in memory, but Metro never bundles it`); for (const f of Object.keys(bundled)) assert.equal(u.has(f), true, `${f} is not seen, but Metro's blockList does not exclude it (§114)`);
  });
  it('G13 GH17g: the same raw consumer one directory down, outside those, is caught (the fixture bites)', () => {
    assert.ok(withFiles({ 'src/components/zzGH17g/deep.tsx': GH15D.nested }, unregisteredNow).has('src/components/zzGH17g/deep.tsx'));
  });
  it('G13 GH17h: the app root\'s bundled sources are its script files less the named build configs', () => {
    assert.deepEqual(rootSources(['index.js', 'App.tsx', 'babel.config.js', 'metro.config.js', 'jest.config.js', 'jest.web.config.js', 'README.md', 'app.json', 'App.test.tsx']), ['index.js', 'App.tsx']);
  });
  it('G13 GH17i: a raw consumer at the app root is seen in memory, as the walk would read it on disk', () => {
    assert.ok(withFiles({ 'index.js': GH15D.rootConsumer }, unregisteredNow).has('index.js'));
  });
  it("G13 GH19f: a carrier module's own `export { carrier as default }`, taken by a default import, is caught", () => {
    assert.throws(() => withFiles({ 'src/services/compass.ts': read('src/services/compass.ts') + GH15D.ownDefaultBraces, 'src/components/zzGH19f.tsx': GH15D.viaOwnDefaultBraces }, wholeGuard), /zzGH19f\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH18f: a barrel re-exporting from a platform variant (mod.web.tsx beside a plain mod.tsx) is caught at the barrel\'s importer', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH18f/mod.tsx': GH15D.platformPlain, 'src/components/zzGH18f/mod.web.tsx': GH15D.platformWeb, 'src/components/zzGH18fbarrel.ts': GH15D.barrel, 'src/components/zzGH18fuse.tsx': GH15D.viaBarrel }, wholeGuard), /zzGH18fuse\.tsx \(fetchCompassRecommendations\)/);
  });
});

/** §113: a directory the walk never enters. The walk and the overlay share it. */
function walkSkipsDir(name: string): boolean {
  return name === 'node_modules' || metroBlocks(`/${name}/`);  // §114: exactly the directories Metro's blockList excludes — __mocks__ and __fixtures__ are bundled (GH25, GH27, GH28)
}

/** §113: the files at the app root the walk reads — every bundled script, less the named build configs (isWalkedPath). */
function rootSources(names: string[]): string[] {
  return names.filter((n) => isWalkedPath(n));
}

// ── census-discovery §114 (DV-83 round 17, lane W11-X2): the round-16 verifier's fixtures (GH25–GH32) ──────────────
//
// The walk skipped `__fixtures__` and `__mocks__`, but Metro's blockList (metro.config.js) excludes only `__tests__/`
// and `*.test.*` files — and src/data/discovery.ts re-exports everything from src/__fixtures__, so that directory IS in
// the bundle (GH28 is that live pattern). The skipped set is now read from Metro's own blockList (metroBlocks), so the
// walk reads exactly what Metro may bundle. GH29–GH32 are the fixtures under which the guard mutations R3, R5, R6 and
// R7 survived: each is a case here, so each reading they touch is load-bearing.
const GH16F = {
  fixturesBarrel: "export { fetchCompassRecommendations as zzRecsGH25 } from '../../services/compass.ts';\n",
  viaFixtures: "import { zzRecsGH25 } from './__fixtures__/zzGH25.ts';\nexport async function zzRawRecsGH25(): Promise<number> {\n  const res = await zzRecsGH25({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  mocksConsumer: "import { fetchCompassRecommendations } from '../../services/compass.ts';\nexport async function zzRawRecsGH27(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  viaMocks: "import { zzRawRecsGH27 } from './__mocks__/zzGH27.tsx';\nexport const zzUseGH27 = () => zzRawRecsGH27();\n",
  fixturesConsumer: "import { getDiscoveryPlaces } from '../services/discovery.ts';\nexport async function zzFixturePlacesGH28(): Promise<number> {\n  const res = await getDiscoveryPlaces('Lisbon', 'food', {} as never, 1);\n  return res.ok ? res.data.places.length : 0;\n}\n",
  dataReexport: "export * from '../__fixtures__/zzGH28.ts';\n",
  handedByAssign: "\n// GH29 (v16 verifier): a registered consumer hands the carrier on by plain assignment (never calls it here).\nconst zzHandGH29 = fetchCompassRecommendations;\nexport const zzHandedGH29 = { load: zzHandGH29 };\n",
  jsxConsumer: "import { fetchCompassRecommendations } from '../services/compass.ts';\nexport async function zzRawRecsGH30() {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  iosReexport: "export { fetchCompassRecommendations as zzRecsGH31 } from '../../services/compass.ts';\n",
  viaIosIndex: "import { zzRecsGH31 } from " + "'./zzGH31b';\nexport async function zzRawRecsGH31b(): Promise<number> {\n  const res = await zzRecsGH31({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  importAlias: "\n// GH32 (v16 verifier): a registered consumer imports the carrier a second time under an alias and hands the alias on.\nimport { fetchCompassRecommendations as zzAliasGH32 } from '../../services/compass.ts';\nexport const zzHandedGH32 = [zzAliasGH32];\n",
};

describe("DV-83 guard reach — the round-16 verifier's fixtures (§114)", () => {
  const PASSPORT = 'src/components/compass/CompassPassportSuggestions.tsx';
  it('G13 GH25: a re-export module under __fixtures__ is read, and its importer is caught', () => {
    assert.throws(() => withFiles({ 'src/components/__fixtures__/zzGH25.ts': GH16F.fixturesBarrel, 'src/components/zzGH25use.tsx': GH16F.viaFixtures }, wholeGuard), /zzGH25use\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH27: a raw consumer under __mocks__, imported by live code, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/__mocks__/zzGH27.tsx': GH16F.mocksConsumer, 'src/components/zzGH27use.tsx': GH16F.viaMocks }, wholeGuard), /__mocks__\/zzGH27\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH28: a raw consumer in src/__fixtures__, re-exported by src/data/ through `export *` (the live pattern), is caught', () => {
    assert.throws(() => withFiles({ 'src/__fixtures__/zzGH28.ts': GH16F.fixturesConsumer, 'src/data/zzGH28.ts': GH16F.dataReexport }, wholeGuard), /src\/__fixtures__\/zzGH28\.ts \(getDiscoveryPlaces\)/);
  });
  it('G13 GH28b: the live tree — src/__fixtures__ and src/__mocks__ are walked, as Metro bundles them', () => {
    const sources = clientSources();
    for (const f of ['src/__fixtures__/discovery.ts', 'src/__fixtures__/events.ts', 'src/__mocks__/expo-router.tsx']) assert.ok(sources.includes(f), `${f} is not walked`);
    assert.equal(sources.some((f) => f.includes('/__tests__/') || /\.test\.(tsx?|jsx?)$/.test(f)), false, 'a test is walked');
  });
  it("G13 GH17j: the skipped set is Metro's own blockList, read from metro.config.js", () => {
    assert.deepEqual(['node_modules', '__tests__', '__mocks__', '__fixtures__', 'components'].map(walkSkipsDir), [true, true, false, false, false]);
    assert.deepEqual(['a.tsx', 'a.test.tsx', 'a.component.test.tsx', 'a.test.js', 'a.jsx'].map(isClientSource), [true, false, false, false, true]);
    const metro = read('metro.config.js');
    const blocked = metro.replace(String.raw`  /\/__tests__\/.*/,`, String.raw`  /\/__tests__\/.*/,
  /\/__fixtures__\/.*/,`);
    assert.notEqual(blocked, metro, 'the fixture edits the blockList');
    assert.equal(withFiles({ 'metro.config.js': blocked }, () => walkSkipsDir('__fixtures__')), true, 'a directory Metro blocks is skipped');
  });
  it('G13 GH29: a carrier handed on by plain assignment in a registered consumer fails the reference pin (R3)', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH16F.handedByAssign }, wholeGuard), /non-call reference/);
  });
  it('G13 GH30: a raw consumer in a .jsx source is caught (R5)', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH30.jsx': GH16F.jsxConsumer }, wholeGuard), /zzGH30\.jsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH31b: a re-export that exists only as a directory index.ios.tsx is caught at its importer (R6)', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH31b/index.ios.tsx': GH16F.iosReexport, 'src/components/zzGH31buse.tsx': GH16F.viaIosIndex }, wholeGuard), /zzGH31buse\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH32: a carrier imported again under an alias and handed on fails the reference pin (R7)', () => {
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + GH16F.importAlias }, wholeGuard), /non-call reference/);
  });
});

/**
 * §114: Metro's blockList, read from metro.config.js itself — the walk and the overlay skip exactly what Metro never
 * bundles, and a change to the blockList changes the walk with it. Read from the overlay when a case lays one over the
 * config (GH17j); otherwise read once for the run.
 */
function metroBlockList(): RegExp[] {
  const cache = metroBlockList as unknown as { disk?: RegExp[] };
  const overlaid = overlayHas('metro.config.js');
  if (!overlaid && cache.disk) return cache.disk;
  const body = /blockList\s*=\s*\[([\s\S]*?)\];/.exec(read('metro.config.js'))?.[1];
  assert.ok(body !== undefined, 'metro.config.js declares no resolver.blockList: the guard cannot tell what Metro bundles');
  const list = [...body.matchAll(/^\s*\/(.+)\/([a-z]*),?\s*$/gm)].map((m) => new RegExp(m[1]!, m[2]));
  assert.ok(list.length > 0, 'metro.config.js\'s blockList holds no regular expression the guard can read');
  if (!overlaid) cache.disk = list;
  return list;
}
function metroBlocks(path: string): boolean {
  return metroBlockList().some((re) => re.test(path));
}

// ── census-discovery §115 (DV-83 round 18, lane W11-X2): the round-17 verifier's fixtures (GH33–GH40) ──────────────
//
// The guard read source with regular expressions over text whose comments a regex had stripped. A `/*` inside a string
// (`'image/*'`, GH33) opened a "comment" that ate code to the next `*/`, and a `//` inside a string cut the rest of its
// line (GH38); `import{x}from'…'` with no whitespace (GH34) and an ES2022 string-literal import name (GH37) matched no
// import regex; and a namespace import spread into an object (GH36) named no member. The source is now read through the
// TypeScript parser (`canonicalSource`): comments are the ones the parser finds between tokens, never text inside a
// string, template or JSX; every import and export declaration is printed in one canonical form (names unquoted, one
// space between tokens), and an identifier spelled with a unicode escape is printed as the name it binds — so every
// reading below it sees the module structure, not its spelling. A namespace used other than as `ns.member` is
// `<dynamic>` (namespaceHandedOn). GH39 and GH40 are the verifier's fixtures under which R3 and R8 survived: a raw
// consumer in a `.test.mjs` file (Metro's blockList does not block `.mjs`) and a raw consumer under `__tests__` with
// that rule removed from the blockList, which `walk()` must then read (it asks walkSkipsDir, not a list of its own).
const GH17V = {
  mimeGlob: "// GH33: a `/*` inside a string.\nexport const ACCEPT_GH33 = 'image/*';\nexport async function zzRawRecsGH33(): Promise<number> {\n  const { fetchCompassRecommendations } = await import('../services/compass.ts');\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n/** The count of recommendations, raw. */\nexport const zzGH33 = 1;\n",
  noSpace: "import{fetchCompassRecommendations}from'../services/compass.ts';\nexport async function zzRawRecsGH34(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  nsSpread: "import * as C from '../services/compass.ts';\nconst api = { ...C };\nexport const zzKeyGH36 = C.CITY_CONFIDENCE_STORAGE_KEY;\nexport async function zzRawRecsGH36(): Promise<number> {\n  const res = await api.fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  stringName: "import { 'fetchCompassRecommendations' as zzRecsGH37 } from '../services/compass.ts';\nexport async function zzRawRecsGH37(): Promise<number> {\n  const res = await zzRecsGH37({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  slashInString: "const SEP_GH38 = 'a//b'; import { fetchCompassRecommendations } from '../services/compass.ts';\nexport async function zzRawRecsGH38(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length + SEP_GH38.length : 0;\n}\n",
  escapedName: "import { fetchCompassRecomm\\u0065ndations } from '../services/compass.ts';\nexport async function zzRawRecsGH35b(): Promise<number> {\n  const res = await fetchCompassRecomm\\u0065ndations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  nsMemberOnly: "import * as C from '../services/compass.ts';\nexport const zzKeyGH36c = C.CITY_CONFIDENCE_STORAGE_KEY;\nexport type ZzGH36c = typeof C;\n",
  commentOnly: "// import { fetchCompassRecommendations } from '../services/compass.ts';\n/* await fetchCompassRecommendations({ surface: 'passport' }); */\nexport const zzGH33c = '/* not a comment */ // nor this';\n",
  testMjsConsumer: "import { fetchCompassRecommendations } from '../services/compass.ts';\nexport async function zzRawRecsGH39() {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  viaTestMjs: "import { zzRawRecsGH39 } from './zzGH39.test.mjs';\nexport const zzUseGH39 = () => zzRawRecsGH39();\n",
  testsDirConsumer: "import { fetchCompassRecommendations } from '../../services/compass.ts';\nexport async function zzRawRecsGH40(): Promise<number> {\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
};

describe("DV-83 guard reach — the round-17 verifier's fixtures (§115)", () => {
  it("G13 GH33: a `/*` inside a string ('image/*') does not hide the dynamic import after it", () => {
    assert.throws(() => withFiles({ 'src/components/zzGH33.tsx': GH17V.mimeGlob }, wholeGuard), /zzGH33\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH34: `import{…}from\'…\'` with no whitespace is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH34.tsx': GH17V.noSpace }, wholeGuard), /zzGH34\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH35b: an imported name spelled with a unicode escape INSIDE the braces is caught, under the name it binds (the verifier\'s GH35 escaped it elsewhere, and was killed)', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH35b.tsx': GH17V.escapedName }, wholeGuard), /zzGH35b\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH36: a namespace import spread into an object (its carrier called through the copy) is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH36.tsx': GH17V.nsSpread }, wholeGuard), /zzGH36\.tsx \(.*<dynamic>.*\)/);
  });
  it('G13 GH36c CONTROL: a namespace read only for a non-carrier member (and as a type) makes no consumer', () => {
    assert.equal(withFiles({ 'src/components/zzGH36c.tsx': GH17V.nsMemberOnly }, () => unregisteredNow().has('src/components/zzGH36c.tsx')), false);
  });
  it('G13 GH37: an ES2022 string-literal import name is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH37.tsx': GH17V.stringName }, wholeGuard), /zzGH37\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH38: a `//` inside a string on the import\'s line does not hide the import', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH38.tsx': GH17V.slashInString }, wholeGuard), /zzGH38\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH33c CONTROL: a carrier named only in comments makes no consumer, and comment-like text in a string stays text', () => {
    assert.equal(withFiles({ 'src/components/zzGH33c.tsx': GH17V.commentOnly }, () => unregisteredNow().has('src/components/zzGH33c.tsx')), false);
    assert.match(canonicalSource(GH17V.commentOnly), /'\/\* not a comment \*\/ \/\/ nor this'/);
    assert.doesNotMatch(canonicalSource(GH17V.commentOnly), /fetchCompassRecommendations/);
  });
  it('G13 GH33d: the canonical form — comments dropped, imports and exports printed one way, strings and JSX text kept', () => {
    const src = "import{a as b,'c' as d}from\"./x.ts\";export{e as 'f'}from'./y.ts';\nconst u = '/*'; const k = <T>{/* gone */}//x{'//'}</T>; // gone\nconst r = /\\/\\*/; const t = `//${u}/*`; /* gone */ export * as ns from './z.ts';\n";
    const out = canonicalSource(src);
    assert.match(out, /^import \{ a as b, c as d \} from '\.\/x\.ts';export \{ e as f \} from '\.\/y\.ts';/);
    assert.match(out, /const u = '\/\*';/);
    assert.match(out, /<T>\{ *\}\/\/x\{'\/\/'\}<\/T>;/);
    assert.match(out, /const r = \/\\\/\\\*\/;/);
    assert.match(out, /const t = `\/\/\$\{u\}\/\*`;/);
    assert.match(out, /export \* as ns from '\.\/z\.ts';/);
    assert.doesNotMatch(out, /gone/);
  });
  it('G13 GH33e: a `.ts` file the TSX grammar misreads (a `<T>x` cast) is parsed as TS, so its imports and comments are still read', () => {
    const out = canonicalSource("const n = <number>value; /* gone */\nimport { a } from './x.ts';\n");
    assert.match(out, /import \{ a \} from '\.\/x\.ts';/);
    assert.doesNotMatch(out, /gone/);
  });
  it('G13 GH35c: a second raw site in a registered consumer, its carrier spelled with a unicode escape, fails', () => {
    const PASSPORT = 'src/components/compass/CompassPassportSuggestions.tsx';
    const site = "\nexport async function zzSecondEscGH35c(): Promise<number> {\n  const res = await fetchCompassRecomm\\u0065ndations({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n";
    assert.throws(() => withFiles({ [PASSPORT]: read(PASSPORT) + site }, wholeGuard), /call site|every site|predicate|sites/i);
  });
  it('G13 GH39: a raw consumer in a `.test.mjs` file Metro bundles (its blockList does not block .mjs) is caught (R3)', () => {
    assert.equal(isClientSource('a.test.mjs'), true, "Metro's blockList does not block .test.mjs, so the walk reads it");
    assert.equal(isClientSource('a.test.tsx'), false);
    assert.throws(() => withFiles({ 'src/components/zzGH39.test.mjs': GH17V.testMjsConsumer, 'src/components/zzGH39use.tsx': GH17V.viaTestMjs }, wholeGuard), /zzGH39\.test\.mjs \(fetchCompassRecommendations\)/);
  });
  it("G13 GH40: walk() follows Metro's blockList — with the __tests__ rule removed, a consumer under __tests__ is walked (R8)", () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dv83-gh40-'));
    try {
      mkdirSync(join(tmp, 'src', 'components', '__tests__'), { recursive: true });
      mkdirSync(join(tmp, 'src', 'components', 'node_modules'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'components', '__tests__', 'zzGH40.tsx'), GH17V.testsDirConsumer);
      writeFileSync(join(tmp, 'src', 'components', 'node_modules', 'zzPkg.ts'), 'export const x = 1;\n');
      writeFileSync(join(tmp, 'src', 'components', 'zzGH40use.tsx'), "import { zzRawRecsGH40 } from './__tests__/zzGH40.tsx';\n");
      assert.deepEqual(walk('src', [], tmp).sort(), ['src/components/zzGH40use.tsx'], 'CONTROL: with the blockList as it is, __tests__ is not walked');
      const metro = read('metro.config.js');
      const unblocked = metro.replace(String.raw`  /\/__tests__\/.*/,` + '\n', '');
      assert.notEqual(unblocked, metro, 'the fixture edits the blockList');
      const walked = withFiles({ 'metro.config.js': unblocked }, () => walk('src', [], tmp).sort());
      assert.deepEqual(walked, ['src/components/__tests__/zzGH40.tsx', 'src/components/zzGH40use.tsx'], 'a directory Metro no longer blocks is walked');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * §115: `src` as the guard reads it — parsed by TypeScript, comments removed (the ranges the parser finds between
 * tokens; JSX text, strings, templates and regular expressions are tokens, never comments), every import and export
 * declaration printed in one canonical form, and every identifier spelled with an escape printed as the name it binds.
 * Memoised by the text (the walk reads each file many times).
 */
function canonicalSource(src: string): string {
  const memo = canonicalSource as unknown as { cache?: Map<string, string> };
  const cache = (memo.cache ??= new Map());
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const sf = parsedSource(src);
  const decls: Array<[number, number, string]> = [];
  for (const st of sf.statements) {
    const printed = canonicalDeclaration(st);
    if (printed !== null) decls.push([st.getStart(sf), st.end, printed]);
  }
  const inDecl = (at: number) => decls.some(([s, e]) => at >= s && at < e);
  const edits: Array<[number, number, string]> = [...decls];
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const kids = node.getChildren(sf);
    if (kids.length > 0) { for (const k of kids) visit(k); return; }
    for (const c of [...(ts.getTrailingCommentRanges(sf.text, node.pos) ?? []), ...(ts.getLeadingCommentRanges(sf.text, node.pos) ?? [])]) {  // a comment on the previous token's line is its "trailing" one
      if (seen.has(c.pos) || inDecl(c.pos)) continue;
      seen.add(c.pos);
      edits.push([c.pos, c.end, c.kind === ts.SyntaxKind.MultiLineCommentTrivia ? ' ' : '']);
    }
    if (ts.isIdentifier(node) && !inDecl(node.getStart(sf)) && node.getText(sf) !== ts.idText(node)) edits.push([node.getStart(sf), node.end, ts.idText(node)]);
  };
  visit(sf);
  let out = src;
  for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
  cache.set(src, out);
  return out;
}

/** The parse of `src`: as TSX, or as TS when that parses with fewer errors (a `<T>(x) =>` or a `<T>x` cast). */
function parsedSource(src: string): ts.SourceFile {
  const memo = parsedSource as unknown as { cache?: Map<string, ts.SourceFile> };
  const cache = (memo.cache ??= new Map());
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const errors = (f: ts.SourceFile) => ((f as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
  let sf = ts.createSourceFile('guard.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (errors(sf) > 0) {
    const asTs = ts.createSourceFile('guard.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (errors(asTs) < errors(sf)) sf = asTs;
  }
  cache.set(src, sf);
  return sf;
}

/** An import or export declaration in its one canonical form (null for any other statement). */
function canonicalDeclaration(st: ts.Statement): string | null {
  const name = (n: ts.ModuleExportName) => (ts.isIdentifier(n) ? ts.idText(n) : /^[A-Za-z_$][\w$]*$/.test(n.text) ? n.text : JSON.stringify(n.text));
  const spec = (m: ts.Expression | undefined) => (m && ts.isStringLiteral(m) ? `'${m.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : null);
  const element = (e: ts.ImportSpecifier | ts.ExportSpecifier) => `${e.isTypeOnly ? 'type ' : ''}${e.propertyName ? `${name(e.propertyName)} as ` : ''}${name(e.name)}`;
  if (ts.isImportDeclaration(st)) {
    const from = spec(st.moduleSpecifier);
    if (from === null) return null;
    const c = st.importClause;
    if (!c) return `import ${from};`;
    const parts: string[] = [];
    if (c.name) parts.push(ts.idText(c.name));
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) parts.push(`* as ${ts.idText(nb.name)}`);
    else if (nb) parts.push(`{ ${nb.elements.map(element).join(', ')} }`);
    return `import ${c.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${from};`;
  }
  if (ts.isExportDeclaration(st)) {
    const from = st.moduleSpecifier ? spec(st.moduleSpecifier) : '';
    if (from === null) return null;
    const ec = st.exportClause;
    const body = !ec ? '*' : ts.isNamespaceExport(ec) ? `* as ${name(ec.name)}` : `{ ${ec.elements.map(element).join(', ')} }`;
    return `export ${st.isTypeOnly ? 'type ' : ''}${body}${from ? ` from ${from}` : ''};`;
  }
  return null;
}

/**
 * §115 (GH36): whether the namespace binding `ns` is used other than to read a member (`ns.x`), to be destructured
 * (`const { x } = ns`) or as a type (`typeof ns`, `ns.T`) — spread, passed, stored or re-exported, which hands on every
 * member the guard then cannot see. A declaration of the same name is not a use.
 */
function namespaceHandedOn(src: string, ns: string): boolean {
  const sf = parsedSource(src);
  let handed = false;
  const visit = (node: ts.Node): void => {
    if (handed) return;
    if (ts.isIdentifier(node) && ts.idText(node) === ns) {
      const p = node.parent;
      const declares = (ts.isNamespaceImport(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isJsxAttribute(p) || ts.isLabeledStatement(p)) && (p as { name?: ts.Node }).name === node;
      const member = (ts.isPropertyAccessExpression(p) && (p.expression === node || p.name === node)) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p);
      const destructured = ts.isVariableDeclaration(p) && p.initializer === node && ts.isObjectBindingPattern(p.name);
      if (!declares && !member && !destructured) handed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return handed;
}

// ── census-discovery §116 (DV-83 round 19, lane W11-X2): the round-18 verifier's fixtures (GH41–GH44, GHX6) ───────────
//
// §115 read declarations through the parser, but `import()` and `require()` were still found by regular expressions over
// the canonical text (`\bimport\(`, `\brequire\(`, `\bawait\s+import\(`): whitespace or a comment before the parenthesis
// (GH41, GH43, GH44 — Metro bundles all three) and an escaped character in the specifier (GH42: the string's VALUE is the
// module, its spelling is not) escaped them. They are now read from the syntax tree (`moduleLoads`): a call whose callee
// is the `import` keyword or the identifier `require`, its specifier the literal's value as the parser unescaped it (null
// when computed). X6 (a block comment removed to '' instead of one space) survived because nothing pinned that a block
// comment SEPARATES two tokens: GHX6 is the verifier's fixture, GHX6b a registered consumer's alias whose `const` and name
// only a space keeps apart, GHX6c the canonical form itself.
const GH18V = {
  spaceParen: "export async function zzRawRecsGH41(): Promise<number> {\n  const { fetchCompassRecommendations } = await import ('../services/compass.ts');\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  escapedSpec: "export async function zzRawRecsGH42(): Promise<number> {\n  const { fetchCompassRecommendations } = await import('../services/compass\\u002ets');\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  requireSpace: "export function zzRawRecsGH43(): Promise<number> {\n  const { fetchCompassRecommendations } = require ('../services/compass.ts');\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok && res.data ? res.data.recommendations.length : 0));\n}\n",
  commentParen: "export async function zzRawRecsGH44(): Promise<number> {\n  const m = await import /* lazy */ ('../services/compass.ts');\n  const res = await m.fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  computedSpace: "const zzSpecGH41b = '../services/compass.ts';\nexport async function zzRawRecsGH41b(): Promise<number> {\n  const m = await import (zzSpecGH41b);\n  return (await m.fetchCompassRecommendations({ surface: 'passport' })).ok ? 1 : 0;\n}\n",
  gluedComment: "export async function zzRawRecsGHX6(): Promise<number> {\n  const { fetchCompassRecommendations } = await/**/import('../services/compass.ts');\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  gluedAlias: "\nexport async function zzAliasSiteGHX6b(): Promise<number> {\n  const/**/zzLoadX6 = fetchCompassRecommendations;\n  const res = await zzLoadX6({ surface: 'passport', limit: 3 });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  importEquals: "import zzCompassGH43b = require('../services/compass.ts');\nexport const zzRecsGH43b = () => zzCompassGH43b.fetchCompassRecommendations({ surface: 'passport' });\n",
  escapedRequire: "export function zzRawRecsGH43c(): Promise<number> {\n  const { fetchCompassRecommendations } = \\u0072equire('../services/compass.ts');\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok ? 1 : 0));\n}\n",
  unbundledReach: "export const zzLoadGH41r = () => import ('../../scripts/zzGH41r.js');\n",
  otherCalls: "export const zzA = obj.require('../services/compass.ts');\nexport const zzB = requireX('../services/compass.ts');\nexport type ZzT = typeof import('../services/compass.ts');\n",
};

describe("DV-83 guard reach — the round-18 verifier's fixtures (§116)", () => {
  it('G13 GH41: `await import (x)`, whitespace before the parenthesis, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH41.tsx': GH18V.spaceParen }, wholeGuard), /zzGH41\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH41b: a COMPUTED specifier after `import (`, whitespace before the parenthesis, is refused', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH41b.tsx': GH18V.computedSpace }, wholeGuard), /zzGH41b\.tsx|computed specifier/);
  });
  it('G13 GH42: an escaped character in a dynamic-import specifier (its value is the module) is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH42.tsx': GH18V.escapedSpec }, wholeGuard), /zzGH42\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GH43: `require (x)`, whitespace before the parenthesis, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH43.tsx': GH18V.requireSpace }, wholeGuard), /zzGH43\.tsx \(<dynamic>\)/);
  });
  it('G13 GH44: `import /* c */ (x)`, a comment before the parenthesis, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH44.tsx': GH18V.commentParen }, wholeGuard), /zzGH44\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GHX6: `await/**/import(x)`, `await` and `import` apart only by a block comment, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGHX6.tsx': GH18V.gluedComment }, wholeGuard), /zzGHX6\.tsx \(fetchCompassRecommendations\)/);
  });
  it('G13 GHX6b: a second raw site through an alias declared `const/**/name = carrier` fails G9 (a block comment separates tokens)', () => {
    const file = 'src/components/compass/CompassPassportSuggestions.tsx';
    assert.throws(() => withFiles({ [file]: read(file) + GH18V.gluedAlias }, () => compassConsumersBranchOnCoverage()), /call site|without the shared predicate/i);
  });
  it('G13 GHX6c: the canonical form keeps a block comment between two tokens as one space', () => {
    assert.equal(canonicalSource('const/**/x = 1;'), 'const x = 1;');
    assert.equal(canonicalSource('await/* c */import(y);'), 'await import(y);');
  });
  it('G13 GH43b: `import x = require(…)` of a carrier module is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH43b.tsx': GH18V.importEquals }, wholeGuard), /zzGH43b\.tsx \(<dynamic>\)/);
  });
  it('G13 GH43c: `require` spelled with a unicode escape is the same call, and is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH43c.tsx': GH18V.escapedRequire }, wholeGuard), /zzGH43c\.tsx \(<dynamic>\)/);
  });
  it('G13 GH41r: `import (x)` into a directory the guard does not walk is seen by the reach check', () => {
    assert.deepEqual(withFiles({ 'src/components/zzGH41r.tsx': GH18V.unbundledReach }, () => unbundledReach(withOverlay(clientSources())).filter((r) => r.includes('zzGH41r'))), ['src/components/zzGH41r.tsx → scripts/zzGH41r.js']);
  });
  it('G13 GH41c: a member `.require(…)`, another function named like it and a type-only `import(…)` load nothing (the regexes read the first and last as loads)', () => {
    assert.equal(withFiles({ 'src/components/zzGH41c.tsx': GH18V.otherCalls }, () => unregisteredNow().has('src/components/zzGH41c.tsx')), false);
  });
});

/**
 * §116 (GH41–GH44): every `import()` and `require()` in `src`, read from the syntax tree — a call whose callee is the
 * `import` keyword or the identifier `require` (however it is spelled, spaced or commented), and `import x = require(…)`.
 * `spec` is the literal's value as the parser unescaped it, and null for a computed specifier. A type-only
 * `typeof import(…)` loads nothing, and neither does a member `.require(…)`. Memoised by the text.
 */
interface ModuleLoad { kind: 'import' | 'require'; spec: string | null; call: ts.Node; text: string }
function moduleLoads(src: string): ModuleLoad[] {
  const memo = moduleLoads as unknown as { cache?: Map<string, ModuleLoad[]> };
  const cache = (memo.cache ??= new Map());
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const sf = parsedSource(src);
  const out: ModuleLoad[] = [];
  const literal = (w: ts.Expression | undefined) => { const a = w && unwrapOuter(w); return a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null; };  // census-discovery §117 (GH48): `import(('x'))` is the literal
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const e = unwrapOuter(node.expression);  // census-discovery §117 (GH45–GH47, GH49): `(require)`, `require!`, `(require as T)`, `(require satisfies T)` are require
      const kind = e.kind === ts.SyntaxKind.ImportKeyword ? 'import' : ts.isIdentifier(e) && ts.idText(e) === 'require' ? 'require' : null;
      if (kind) out.push({ kind, spec: literal(node.arguments[0]), call: node, text: node.getText(sf) });
    } else if (ts.isExternalModuleReference(node)) out.push({ kind: 'require', spec: literal(node.expression), call: node, text: node.getText(sf) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  cache.set(src, out);
  return out;
}

/** §116: the imports from `files` into a directory the guard does not walk — static `from`, and `import()` / `require()` read from the syntax tree (GH41–GH44). */
function unbundledReach(files: string[]): string[] {
  const reach: string[] = [];
  for (const file of files) {
    for (const spec of [...[...stripComments(read(file)).matchAll(/\bfrom\s*['"`]([^'"`$]+)['"`]/g)].map((m) => m[1]!), ...moduleLoads(read(file)).flatMap((d) => (d.spec === null ? [] : [d.spec]))]) {
      const target = resolveSpec(file, spec);
      const code = !/\.(?:webp|png|jpe?g|gif|svg|ttf|otf|mp3|wav|mp4|json|lottie)$/i.test(target ?? '');  // an image or a font is not a module that can read a carrier
      if (target && code && target.split('/')[0]! in clientNotBundled() && target.split('/')[0] !== 'node_modules') reach.push(`${file} → ${target}`);
    }
  }
  return reach;
}

// ── census-discovery §117 (DV-83 round 20, lane W11-X2): the round-19 verifier's fixtures (GH45–GH49) ────────────────
//
// §116 read `require(…)` only when the callee WAS the identifier: `(require)(x)`, `require!(x)`, `(require as T)(x)` and
// `(require satisfies T)(x)` put a parenthesis, a non-null assertion or a type assertion around it, which Babel strips —
// so Metro bundles a plain `require(x)` the guard could not see (GH45–GH47, GH49). `import(('x'))` was refused as a
// computed specifier, though its value is a literal (GH48). `moduleLoads` now looks through those wrappers on the callee
// and on the specifier (`unwrapOuter`). GH50 pins the wrappers nested; GH45c pins that a wrapped member `.require` still
// loads nothing.
const GH19V = {
  parenRequire: "export function zzRawRecsGH45(): Promise<number> {\n  const { fetchCompassRecommendations } = (require)('../services/compass.ts');\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok && res.data ? res.data.recommendations.length : 0));\n}\n",
  nonNullRequire: "export function zzRawRecsGH46(): Promise<number> {\n  const { fetchCompassRecommendations } = require!('../services/compass.ts');\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok && res.data ? res.data.recommendations.length : 0));\n}\n",
  asRequire: "export function zzRawRecsGH47(): Promise<number> {\n  const { fetchCompassRecommendations } = (require as NodeRequire)('../services/compass.ts');\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok && res.data ? res.data.recommendations.length : 0));\n}\n",
  parenSpec: "export async function zzRawRecsGH48(): Promise<number> {\n  const { fetchCompassRecommendations } = await import(('../services/compass.ts'));\n  const res = await fetchCompassRecommendations({ surface: 'passport' });\n  return res.ok && res.data ? res.data.recommendations.length : 0;\n}\n",
  satisfiesRequire: "export function zzRawRecsGH49(): Promise<number> {\n  const { fetchCompassRecommendations } = (require satisfies NodeRequire)('../services/compass.ts');\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok && res.data ? res.data.recommendations.length : 0));\n}\n",
  nested: "export function zzRawRecsGH50(): Promise<number> {\n  const { fetchCompassRecommendations } = ((require as any)! satisfies unknown as NodeRequire)((('../services/compass.ts') as string));\n  return fetchCompassRecommendations({ surface: 'passport' }).then((res: any) => (res.ok ? 1 : 0));\n}\n",
  wrappedMember: "export const zzA45c = (obj.require as any)('../services/compass.ts');\nexport const zzB45c = (requireX)!('../services/compass.ts');\n",
};

describe("DV-83 guard reach — the round-19 verifier's fixtures (§117)", () => {
  it('G13 GH45: `(require)(x)`, a parenthesized callee, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH45.tsx': GH19V.parenRequire }, wholeGuard), /zzGH45\.tsx \(<dynamic>\)/);
  });
  it('G13 GH46: `require!(x)`, a non-null-asserted callee, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH46.tsx': GH19V.nonNullRequire }, wholeGuard), /zzGH46\.tsx \(<dynamic>\)/);
  });
  it('G13 GH47: `(require as NodeRequire)(x)`, a type-asserted callee, is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH47.tsx': GH19V.asRequire }, wholeGuard), /zzGH47\.tsx \(<dynamic>\)/);
  });
  it('G13 GH48: `import((x))`, a parenthesized literal specifier, is read as that literal (not refused as computed)', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH48.tsx': GH19V.parenSpec }, wholeGuard), /zzGH48\.tsx \(fetchCompassRecommendations\)/);
    assert.deepEqual(moduleLoads(GH19V.parenSpec).map((d) => [d.kind, d.spec]), [['import', '../services/compass.ts']]);
  });
  it('G13 GH49: `(require satisfies NodeRequire)(x)` is caught', () => {
    assert.throws(() => withFiles({ 'src/components/zzGH49.tsx': GH19V.satisfiesRequire }, wholeGuard), /zzGH49\.tsx \(<dynamic>\)/);
  });
  it('G13 GH50: the wrappers nested, on the callee and on the specifier, are looked through', () => {
    assert.deepEqual(moduleLoads(GH19V.nested).map((d) => [d.kind, d.spec]), [['require', '../services/compass.ts']]);
    assert.throws(() => withFiles({ 'src/components/zzGH50.tsx': GH19V.nested }, wholeGuard), /zzGH50\.tsx \(<dynamic>\)/);
  });
  it('G13 GH45c: a wrapped member `.require` and a wrapped other function load nothing', () => {
    assert.deepEqual(moduleLoads(GH19V.wrappedMember), []);
    assert.equal(withFiles({ 'src/components/zzGH45c.tsx': GH19V.wrappedMember }, () => unregisteredNow().has('src/components/zzGH45c.tsx')), false);
  });
});

/**
 * §117 (GH45–GH49): the expression under every parenthesis, non-null assertion and type assertion (`as`, `<T>x`,
 * `satisfies`) and instantiation expression around it — the wrappers Babel strips before Metro collects a dependency.
 * TypeScript's own `skipOuterExpressions` does this, but it is not in TypeScript 5.9's public typings, so the guard does
 * not lean on it; this is the same walk over the same kinds.
 */
function unwrapOuter(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isExpressionWithTypeArguments(e) || ts.isPartiallyEmittedExpression(e)) e = e.expression;
    else return e;
  }
}

// ── census-discovery §117 (DV-83 round 20, lane W11-X2): the two wrappers GH45–GH50 did not draw ───────────────────
//
// `unwrapOuter` also looks through an angle-bracket assertion (`(<any>require)(x)`, legal in a .ts file, which the
// guard parses as TS when TSX cannot) and an instantiation expression (`(require<any>)(x)`); Babel strips both, so
// Metro bundles a plain `require(x)`. GH51 and GH52 pin them, so neither reading can be dropped unseen.
describe("DV-83 guard reach — the angle-bracket and instantiation wrappers (§117)", () => {
  it('G13 GH51: (<any>require)(x) in a .ts source is a require of x', () => {
    assert.deepEqual(moduleLoads("const m = (<any>require)('../services/compass.ts');\nexport default m;\n").map((d) => [d.kind, d.spec]), [['require', '../services/compass.ts']]);
  });
  it('G13 GH52: (require<any>)(x) is a require of x', () => {
    assert.deepEqual(moduleLoads("const m = (require<any>)('../services/compass.ts');\nexport default m;\n").map((d) => [d.kind, d.spec]), [['require', '../services/compass.ts']]);
  });
});

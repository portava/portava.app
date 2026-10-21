/**
 * G109 — selecting a structured field prefills dependents (Venue → City /
 * Country / Coordinates / Timezone).
 *
 * WHAT THE ROW ASKED FOR, AND WHAT WAS MISSING. The CITY half has been complete
 * since §17: `cityBinding` carries city, country, country code, coordinates and
 * an offline-derived IANA zone. The spec's worked example, though, runs from a
 * VENUE — Sky36 → Da Nang → Vietnam → coordinates → Asia/Ho_Chi_Minh — and
 * selecting a place emitted a bare `open_entity` with no structured value at
 * all. So the dependency graph existed for one node class out of the two named,
 * and a venue selection prefilled nothing.
 *
 * THE FOUR CASES BELOW ARE THE ROW'S OWN ACCEPTANCE CRITERIA, plus the two
 * refusals that keep the prefill honest:
 *
 *   1. a venue selection carries all four dependents;
 *   2. the coordinates are the VENUE's, not the city centroid's, and the
 *      timezone is derived from them;
 *   3. a place with NO canonical link binds with a null country rather than an
 *      inferred one — "Springfield" names places in dozens of countries;
 *   4. a canonical link to something that is NOT a city yields no cityId, but
 *      still yields the country, because a landmark row knows its country and
 *      that is a fact about where the venue is.
 *
 * MUTATION LOG (each reverted after):
 *   • `lat: place.lat` → `canonical.lat`         reddens case 2
 *   • `country: canonical?.country` → `null`     reddens cases 1 and 4
 *   • CITY_KINDS gains 'landmark'                reddens case 4
 *   • dropping the `structuredValue` assignment  reddens case 1
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { venueBinding, timezoneForCoords } from '../lib/inputAssistance/geoResolver.js';
import { resolveVenueBindings } from '../lib/inputAssistance/gateway.js';
import { projectSearchResult } from '../lib/inputAssistance/projection.js';
import type { CanonicalRow } from '../lib/canonicalLocations.js';
import type { SearchResult } from '../routes/discoverySearch.js';

/** Sky36 is on the 36th floor of the Novotel on the Han river, Da Nang. */
const SKY36 = { id: 'venue-sky36', name: 'Sky36', city: 'Da Nang', lat: 16.0678, lng: 108.2233 };

/** The Da Nang canonical CITY row. Its centroid is deliberately NOT Sky36's. */
const DA_NANG: CanonicalRow = {
  id: 'canon-da-nang',
  kind: 'city',
  name: 'Da Nang',
  normalized_name: 'da nang',
  display_name: 'Da Nang, Vietnam',
  city: 'Da Nang',
  region: null,
  country: 'Vietnam',
  country_code: 'VN',
  postal_code: null,
  lat: 16.0544,
  lng: 108.2022,
} as CanonicalRow;

describe('§17/G109 — a venue selection prefills its dependents', () => {
  test('all four dependents are present', () => {
    const b = venueBinding(SKY36, DA_NANG);
    assert.equal(b.entityType, 'venue');
    assert.equal(b.venueId, 'venue-sky36');
    assert.equal(b.city, 'Da Nang');
    assert.equal(b.cityId, 'canon-da-nang');
    assert.equal(b.country, 'Vietnam');
    assert.equal(b.countryCode, 'VN');
    assert.equal(typeof b.lat, 'number');
    assert.equal(typeof b.lng, 'number');
    assert.equal(b.timezone, 'Asia/Ho_Chi_Minh');
  });

  test("the coordinates are the VENUE's, and the timezone is derived from them", () => {
    const b = venueBinding(SKY36, DA_NANG);
    // The whole point of a venue binding: a map pin must land on the venue, not
    // in the middle of town. If these ever equal the canonical centroid, the
    // binding has started substituting the city's position for the place's.
    assert.equal(b.lat, SKY36.lat);
    assert.equal(b.lng, SKY36.lng);
    assert.notEqual(b.lat, DA_NANG.lat);
    assert.notEqual(b.lng, DA_NANG.lng);
    assert.equal(b.timezone, timezoneForCoords(SKY36.lat, SKY36.lng));
  });

  test('a place with no canonical link gets a city NAME but never an inferred country', () => {
    const b = venueBinding(
      { id: 'v2', name: "Joe's Diner", city: 'Springfield', lat: 39.7817, lng: -89.6501 },
      null,
    );
    // The name is known from the place row and is honest; the id and the
    // country are not, and are not invented. "Springfield" names places in
    // dozens of countries — a prefilled country the user did not choose is
    // worse than an empty one they will fill.
    assert.equal(b.city, 'Springfield');
    assert.equal(b.cityId, null);
    assert.equal(b.country, null);
    assert.equal(b.countryCode, null);
    // Coordinates and timezone need no canonical row at all, so they survive.
    assert.equal(b.lat, 39.7817);
    assert.equal(b.timezone, 'America/Chicago');
  });

  test('a link to a non-city canonical row yields the country but no cityId', () => {
    const landmark: CanonicalRow = { ...DA_NANG, id: 'canon-dragon-bridge', kind: 'landmark', name: 'Dragon Bridge' };
    const b = venueBinding(SKY36, landmark);
    // A venue linked to another venue has not thereby acquired a city, and
    // putting "Dragon Bridge" in a field labelled City would be a visible lie.
    assert.equal(b.cityId, null);
    assert.notEqual(b.city, 'Dragon Bridge');
    assert.equal(b.city, 'Da Nang', 'falls back to the place row’s own free-text city');
    // The country is still a fact about where the venue is.
    assert.equal(b.country, 'Vietnam');
    assert.equal(b.countryCode, 'VN');
  });

  test('a place with no coordinates yields no timezone rather than a fabricated one', () => {
    const b = venueBinding({ id: 'v3', name: 'Somewhere', city: null, lat: null, lng: null }, DA_NANG);
    assert.equal(b.timezone, null, 'tz must not be borrowed from the city when the venue has no position');
    assert.equal(b.lat, null);
    // The city half still binds — a missing position does not erase a known city.
    assert.equal(b.cityId, 'canon-da-nang');
    assert.equal(b.country, 'Vietnam');
  });
});

// ── The gateway half: one batched read, and what happens when it fails ────────

/**
 * A `canonical_locations` reader that records its calls, so the batching claim
 * is measured rather than asserted. `fail` makes the read resolve with an error
 * the way supabase-js actually does — it RESOLVES on failure, which is the seam
 * that makes a swallowed read look like an empty one.
 */
function fakeClient(rows: CanonicalRow[], opts: { fail?: boolean } = {}) {
  const calls: { table: string; ids: string[] }[] = [];
  return {
    calls,
    from(table: string) {
      const b: any = {
        select: () => b,
        in: (_col: string, ids: string[]) => {
          calls.push({ table, ids });
          return b;
        },
        then: (onF: any, onR: any) =>
          Promise.resolve(
            opts.fail
              ? { data: null, error: { message: 'simulated canonical_locations outage' } }
              : { data: rows, error: null },
          ).then(onF, onR),
      };
      return b;
    },
  };
}

function placeResult(id: string, name: string, city: string | null, linkId: string | null): SearchResult {
  return {
    id,
    type: 'places',
    title: name,
    subtitle: null,
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: '',
    locationPreview: city,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: { canAccess: true },
    destinationRoute: `/place/${id}`,
    metadata: { lat: 16.0678, lng: 108.2233, ...(linkId ? { livingPageId: linkId } : {}) },
    createdAt: null,
    startsAt: null,
  } as unknown as SearchResult;
}

describe('§17/G109 — the gateway resolves bindings in one read, and fails closed', () => {
  test('one batched read covers every linked place in the request', async () => {
    const sc = fakeClient([DA_NANG]);
    const out = await resolveVenueBindings(sc, [
      placeResult('v1', 'Sky36', 'Da Nang', 'canon-da-nang'),
      placeResult('v2', 'Madame Lan', 'Da Nang', 'canon-da-nang'),
      placeResult('v3', 'Unlinked Cafe', 'Da Nang', null),
    ]);
    assert.equal(sc.calls.length, 1, 'three places must cost ONE canonical read, not three');
    assert.deepEqual(sc.calls[0].ids, ['canon-da-nang'], 'the duplicate link id is deduped before the read');
    assert.equal(out.size, 3);
    assert.equal(out.get('v1')?.country, 'Vietnam');
    assert.equal(out.get('v2')?.cityId, 'canon-da-nang');
  });

  test('no linked place means no read at all', async () => {
    const sc = fakeClient([DA_NANG]);
    const out = await resolveVenueBindings(sc, [placeResult('v3', 'Unlinked Cafe', 'Da Nang', null)]);
    assert.equal(sc.calls.length, 0, 'a request with nothing to look up must not issue a query');
    assert.equal(out.get('v3')?.city, 'Da Nang');
    assert.equal(out.get('v3')?.country, null);
  });

  test('FAIL-CLOSED: an unreadable canonical row yields NO binding, not a null country', async () => {
    const sc = fakeClient([], { fail: true });
    const out = await resolveVenueBindings(sc, [
      placeResult('v1', 'Sky36', 'Da Nang', 'canon-da-nang'),
      placeResult('v3', 'Unlinked Cafe', 'Da Nang', null),
    ]);
    // This is the distinction the whole helper exists to preserve. §17 PREFILLS
    // dependent fields from this value, so an outage rendered as `country: null`
    // would write "this venue is in no country" into a field the user can see.
    // Absent prefill is a smaller harm than wrong prefill.
    assert.equal(out.has('v1'), false, 'a linked place whose read failed must be skipped entirely');
    // The unlinked place is unaffected: its null country was never a lookup.
    assert.equal(out.has('v3'), true);
    assert.equal(out.get('v3')?.country, null);
  });

  test('the projector attaches the binding, and attaches nothing without one', () => {
    const r = placeResult('v1', 'Sky36', 'Da Nang', 'canon-da-nang');
    const b = venueBinding(SKY36, DA_NANG);

    const withBinding = projectSearchResult(r, 'place_picker', 'v-test', 'sky', { venueBinding: b });
    assert.deepEqual(withBinding.structuredValue, b);

    const without = projectSearchResult(r, 'place_picker', 'v-test', 'sky', {});
    assert.equal(
      'structuredValue' in without,
      false,
      'a row with no binding must carry NO key — an absent binding is not a venue that is in no city',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §34 "Prefer server: provider federation" (census G222), §36 provider
// neutrality (G237), §23 provider disagreement (G153) and §30 the precedence
// chain (G192) — wave 4, 2026-10-17.
//
// THE PROVIDER. No paid provider is added (OD-INPUT-6). The one approved
// candidate source is the dataset the tree already holds: FSQ OS Places, an
// open dataset ingested per city into `fsq_places` (migration 0184), gated by
// that dataset's own flag `fsq_places_enabled` (seeded FALSE) and carrying its
// required attribution. The lane runs on the SERVER, inside the gateway, for the
// venue pickers only; its rows are §9 step 9 (`source: 'provider'`), below every
// canonical row, capped, and bound as a Place the picker resolves canonically
// on selection.
//
// THE RULES THE LANE OBEYS, each pinned below:
//   G237  the merge never consults which source a row came from or the order
//         sources were registered in; identical rows score identically.
//   G153  a provider record of a venue Portava already has is NOT shown — the
//         canonical record stands, unchanged; an uncertain match is shown as a
//         separate CHOICE, never merged into the canonical row.
//   G192  that decision is §30's ladder (canonical identity > … > approved
//         provider state > …), consulted wherever the two meet, whatever the
//         arrival order.
// ═════════════════════════════════════════════════════════════════════════════
import { it } from 'node:test';
import {
  APPROVED_PROVIDER_ADAPTERS,
  FSQ_OS_PLACES_ADAPTER,
  PRECEDENCE_LADDER,
  PROVIDER_ROW_MAX,
  PROVIDER_LANE_CONTEXTS,
  federateProviderCandidates,
  precedenceRung,
  resolveProviderConflicts,
  resolveByPrecedence,
  type ProviderAdapter,
  type ProviderCandidate,
} from '../lib/inputAssistance/providerFederation.js';
import { generateSuggestions, generateSuggestionsWithCoverage } from '../lib/inputAssistance/gateway.js';
import { resolvePolicy } from '../lib/inputAssistance/policyRegistry.js';
import { orderSuggestions } from '../lib/inputAssistance/projection.js';
import type { InputSuggestion } from '../lib/inputAssistance/types.js';

const VIEWER = 'aa000000-0000-4000-a000-0000000000f1';
const DA_NANG_AT = { lat: 16.0678, lng: 108.2233 };

/** A permissive fake: every table answers [] unless given rows; reads are recorded with their filters. */
function providerWorld(opts: { flagOn?: boolean; fsq?: any[]; places?: any[]; fsqError?: boolean } = {}) {
  const reads: Array<{ table: string; filters: string[] }> = [];
  const like = (pat: string) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
  const client: any = {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const log: string[] = [];
      let flagName = '';
      let limitN = Infinity;
      const source = (): any[] => (table === 'fsq_places' ? opts.fsq ?? [] : table === 'discovery_places' ? opts.places ?? [] : []);
      const matched = () => source().filter((r) => filters.every((f) => f(r))).slice(0, limitN);
      const b: any = new Proxy({}, {
        get(_t, prop: string) {
          switch (prop) {
            case 'eq': return (c: string, v: unknown) => { if (table === 'feature_flags' && c === 'flag') flagName = String(v); log.push(`eq:${c}`); filters.push((r) => r[c] === v); return b; };
            case 'ilike': return (c: string, p: string) => { log.push(`ilike:${c}:${p}`); const re = like(p); filters.push((r) => re.test(String(r[c] ?? ''))); return b; };
            case 'gte': return (c: string, v: number) => { log.push(`gte:${c}`); filters.push((r) => r[c] != null && r[c] >= v); return b; };
            case 'lte': return (c: string, v: number) => { log.push(`lte:${c}`); filters.push((r) => r[c] != null && r[c] <= v); return b; };
            case 'in': return (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
            case 'or': return (expr: string) => {
              const parts = expr.split(',').map((p) => /^(\w+)\.ilike\.(.+)$/.exec(p.trim())).filter(Boolean) as RegExpExecArray[];
              if (parts.length > 0) filters.push((r) => parts.some((m) => like(m[2]).test(String(r[m[1]] ?? ''))));
              return b;
            };
            case 'limit': return (n: number) => { limitN = n; return b; };
            case 'maybeSingle': case 'single': return async () => {
              if (table === 'feature_flags') return { data: flagName === 'fsq_places_enabled' && opts.flagOn ? { enabled: true } : null, error: null };
              return { data: matched()[0] ?? null, error: null };
            };
            case 'then': return (onF: any, onR: any) => {
              reads.push({ table, filters: log });
              if (table === 'fsq_places' && opts.fsqError) return Promise.resolve({ data: null, error: { message: 'fake: fsq_places unreadable' } }).then(onF, onR);
              return Promise.resolve({ data: matched(), error: null }).then(onF, onR);
            };
            default: return () => b;
          }
        },
      });
      return b;
    },
  };
  return { client, reads, fsqReads: () => reads.filter((r) => r.table === 'fsq_places') };
}

function fsqRow(id: string, name: string, at = DA_NANG_AT, over: Record<string, unknown> = {}) {
  return {
    fsq_id: id, name, latitude: at.lat, longitude: at.lng, category: 'nightlife', fsq_primary_label: 'Bar',
    address: '12 Bach Dang', locality: 'Da Nang', region: 'Da Nang', postcode: null, country: 'VN',
    city_key: 'da-nang-vn', source: 'fsq_os_places', confidence: 'provider', dataset_date: '2026-06-01', ...over,
  };
}
function portavaPlace(id: string, name: string, at = DA_NANG_AT, over: Record<string, unknown> = {}) {
  return {
    id, name, city: 'Da Nang', blurb: null, image_url: null, header_image_source: null, image_source_type: null,
    image_accuracy_status: null, category: 'nightlife', primary_category: 'nightlife', lat: at.lat, lng: at.lng,
    canonical_location_id: null, created_at: '2026-01-01T00:00:00Z', submitted_by: null, status: 'active',
    saved_count: 3, verified: false, ...over,
  };
}
/** `km` east of a point, along the parallel. */
function east(at: { lat: number; lng: number }, km: number) {
  return { lat: at.lat, lng: at.lng + km / (111.32 * Math.cos((at.lat * Math.PI) / 180)) };
}

const PLACE_PICKER = resolvePolicy('place_picker')!;
const serve = (sc: any, text: string, over: Record<string, unknown> = {}) =>
  generateSuggestions(sc, {
    context: 'place_picker', policy: PLACE_PICKER, text, userId: VIEWER, limit: PLACE_PICKER.maxSuggestions,
    lat: DA_NANG_AT.lat, lng: DA_NANG_AT.lng, city: null, ...over,
  } as any);
const providerRows = (rows: InputSuggestion[]) => rows.filter((s) => s.source === 'provider');

describe('§34 G222 — provider federation runs on the server, behind the dataset flag', () => {
  it('the one approved source is the FSQ OS dataset the tree already holds, behind its own flag', () => {
    assert.deepEqual(APPROVED_PROVIDER_ADAPTERS.map((a) => a.key), ['fsq_os_places']);
    assert.equal(FSQ_OS_PLACES_ADAPTER.flag, 'fsq_places_enabled');
    assert.equal(FSQ_OS_PLACES_ADAPTER.attribution, 'Powered by Foursquare');
    assert.deepEqual([...PROVIDER_LANE_CONTEXTS].sort(), ['event_location', 'place_picker', 'trip_stop_place']);
  });

  it('flag off (the seed): no provider row, and the dataset is never read', async () => {
    const w = providerWorld({ flagOn: false, fsq: [fsqRow('fsq-1', 'Skyline Bar')], places: [portavaPlace('p-1', 'Sky36')] });
    const rows = await serve(w.client, 'Sky');
    assert.equal(providerRows(rows).length, 0);
    assert.equal(w.fsqReads().length, 0, 'an unapproved source costs no read');
  });

  it('flag on: a matching venue is served as source "provider", attributed, bound as a Place, below every canonical row', async () => {
    const w = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-1', 'Skyline Bar')], places: [portavaPlace('p-1', 'Sky36')] });
    const rows = await serve(w.client, 'Sky');
    const prov = providerRows(rows);
    assert.equal(prov.length, 1);
    const p = prov[0];
    assert.equal(p.type, 'entity');
    assert.equal(p.entityType, 'place');
    assert.equal(p.entityId, undefined, 'a provider record is not a Portava entity — it carries no canonical id');
    assert.equal(p.attribution, 'Powered by Foursquare');
    assert.equal(p.action?.type, 'set_structured_value');
    const place = p.structuredValue as any;
    assert.equal(place.id, 'foursquare-fsq-1', 'the id space the canonical resolver already knows (providerKeyOf)');
    assert.equal(place.source, 'foursquare');
    assert.equal(place.name, 'Skyline Bar');
    assert.equal(place.city, 'Da Nang');
    assert.equal(place.countryCode, 'VN');
    assert.equal(place.lat, DA_NANG_AT.lat);
    assert.equal(place.timezone, 'Asia/Ho_Chi_Minh');
    const canonIdx = rows.findIndex((s) => s.entityId === 'p-1');
    assert.ok(canonIdx >= 0 && canonIdx < rows.indexOf(p), 'the canonical place leads the provider row');
  });

  it('a provider row never outranks a canonical row, whatever its confidence (§9 step 9)', () => {
    const canon: InputSuggestion = { id: 'c', type: 'entity', context: 'place_picker', label: 'Lantern Cafe', entityType: 'place', entityId: 'c1', action: { type: 'open_entity', entityType: 'place', entityId: 'c1' }, confidence: 0.4, source: 'canonical', policyVersion: 'v' };
    const prov: InputSuggestion = { id: 'p', type: 'entity', context: 'place_picker', label: 'Lantern', entityType: 'place', action: { type: 'set_structured_value', value: {} }, confidence: 0.99, source: 'provider', policyVersion: 'v' };
    assert.deepEqual(orderSuggestions([prov, canon], 8, { query: 'Lantern' }).map((s) => s.id), ['c', 'p']);
  });

  it(`capped: at most ${PROVIDER_ROW_MAX} provider rows in one answer`, async () => {
    const fsq = Array.from({ length: 7 }, (_, i) => fsqRow(`fsq-${i}`, `Sky Bar ${i}`, east(DA_NANG_AT, i * 0.5)));
    const w = providerWorld({ flagOn: true, fsq });
    const rows = await serve(w.client, 'Sky Bar');
    assert.equal(providerRows(rows).length, PROVIDER_ROW_MAX);
  });

  it('bounded read: a box around the position, or the task city; with neither, no read at all', async () => {
    const near = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-1', 'Skyline Bar')] });
    await serve(near.client, 'Sky');
    const f = near.fsqReads()[0]?.filters ?? [];
    for (const k of ['gte:latitude', 'lte:latitude', 'gte:longitude', 'lte:longitude']) assert.ok(f.includes(k), `bounded by ${k}`);

    const none = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-1', 'Skyline Bar')] });
    const rows = await serve(none.client, 'Sky', { lat: null, lng: null });
    assert.equal(none.fsqReads().length, 0, 'an unscoped name scan over a provider table is never issued');
    assert.equal(providerRows(rows).length, 0);

    const far = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-far', 'Skyline Bar', { lat: 21.03, lng: 105.85 })] });
    assert.equal(providerRows(await serve(far.client, 'Sky')).length, 0, 'a venue outside the box is not read');
  });

  it('the paste path (catalog only) and a field that is not a venue picker never reach the lane', async () => {
    const w = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-1', 'Skyline Bar')] });
    assert.equal(providerRows(await serve(w.client, 'Sky', { catalogOnly: true })).length, 0);
    const gs = resolvePolicy('global_search')!;
    assert.equal(providerRows(await serve(w.client, 'Sky', { context: 'global_search', policy: gs })).length, 0);
    assert.equal(w.fsqReads().length, 0);
  });

  it('a Gem location and an address field never receive provider rows, though they take places', async () => {
    const w = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-1', 'Skyline Bar')] });
    for (const context of ['hidden_gem_location', 'address'] as const) {
      const policy = resolvePolicy(context)!;
      assert.ok((policy.entityTypes ?? []).includes('place'), `premise: ${context} takes places`);
      assert.equal(providerRows(await serve(w.client, 'Sky', { context, policy })).length, 0, context);
    }
    assert.equal(w.fsqReads().length, 0);
  });

  it('a provider row\'s confidence stays under the canonical prefix band, even for an exact name', async () => {
    const w = providerWorld({ flagOn: true, fsq: [fsqRow('fsq-1', 'Skyline Bar')] });
    const [p] = providerRows(await serve(w.client, 'Skyline Bar'));
    assert.ok(p, 'premise: the exact-name provider row is served');
    assert.ok((p.confidence ?? 1) < 0.85, `a provider guess is never presented as a strong canonical match (got ${p.confidence})`);
  });

  it('a provider read failure keeps every canonical row and is reported as a partial refusal naming the lane', async () => {
    const w = providerWorld({ flagOn: true, fsqError: true, places: [portavaPlace('p-1', 'Sky36')] });
    const served = await generateSuggestionsWithCoverage(w.client, {
      context: 'place_picker', policy: PLACE_PICKER, text: 'Sky', userId: VIEWER, limit: 8,
      lat: DA_NANG_AT.lat, lng: DA_NANG_AT.lng, city: null,
    } as any);
    assert.ok(served.suggestions.some((s) => s.entityId === 'p-1'), '§38: provider failure must not collapse the canonical answer');
    assert.equal(providerRows(served.suggestions).length, 0);
    assert.equal(served.refusal?.coverage, 'partial');
    assert.ok(JSON.stringify(served.refusal).includes('provider:fsq_os_places'));
  });
});

describe('§23 G153 — provider disagreement: the canonical record or a choice, never an overwrite', () => {
  it('the SAME venue from the provider (40 m, other address and locality spelling) is not shown; the canonical row is byte-identical', async () => {
    const canonOnly = providerWorld({ flagOn: false, places: [portavaPlace('p-1', 'Sky36 Rooftop')] });
    const both = providerWorld({
      flagOn: true,
      places: [portavaPlace('p-1', 'Sky36 Rooftop')],
      fsq: [fsqRow('fsq-dup', 'SKY36 ROOFTOP', east(DA_NANG_AT, 0.04), { locality: 'Đà Nẵng City', address: '36F Novotel' })],
    });
    const a = (await serve(canonOnly.client, 'Sky36')).filter((s) => s.entityId === 'p-1');
    const b = await serve(both.client, 'Sky36');
    assert.equal(providerRows(b).length, 0, 'the provider copy of a venue Portava has is not offered');
    assert.deepEqual(b.filter((s) => s.entityId === 'p-1'), a, 'no provider value reached the canonical row');
  });

  it('an UNCERTAIN match (same name, 600 m away) is offered as a separate choice beside the canonical record', async () => {
    const w = providerWorld({
      flagOn: true,
      places: [portavaPlace('p-1', 'Sky36 Rooftop')],
      fsq: [fsqRow('fsq-near', 'Sky36 Rooftop', east(DA_NANG_AT, 0.6))],
    });
    const rows = await serve(w.client, 'Sky36');
    const canon = rows.find((s) => s.entityId === 'p-1');
    const prov = providerRows(rows);
    assert.ok(canon, 'the canonical record is kept');
    assert.equal(prov.length, 1, 'and the uncertain provider record is a CHOICE, not dropped and not merged');
    assert.match(prov[0].reason ?? '', /Portava/, 'the choice says why it is listed separately');
    assert.notEqual((prov[0].structuredValue as any).id, canon!.entityId);
  });

  it('resolveProviderConflicts names what the superseded provider record disagreed on', () => {
    const cand: ProviderCandidate = { provider: 'fsq_os_places', providerPlaceId: 'x', name: 'Sky36 Rooftop', ...east(DA_NANG_AT, 0.04), locality: 'Đà Nẵng City', region: null, countryCode: 'VN', address: '36F Novotel', category: null };
    const r = resolveProviderConflicts([cand], [{ id: 'p-1', title: 'Sky36 Rooftop', lat: DA_NANG_AT.lat, lng: DA_NANG_AT.lng, city: 'Da Nang' }]);
    assert.deepEqual(r.kept, []);
    assert.equal(r.superseded.length, 1);
    assert.equal(r.superseded[0].canonicalId, 'p-1');
    assert.deepEqual([...r.superseded[0].disagreements].sort(), ['locality', 'position']);
  });
});

describe('§30 G192 — the precedence chain decides when two sources assert one entity', () => {
  it('the ladder is §30\'s seven rungs, in order', () => {
    assert.deepEqual([...PRECEDENCE_LADDER], [
      'canonical_identity', 'authoritative_state', 'community_state', 'approved_provider_state',
      'cached_historical_state', 'user_raw_input', 'ai_guess',
    ]);
  });

  it('every suggestion source has a rung', () => {
    const rung = (source: InputSuggestion['source'], type: InputSuggestion['type'] = 'entity') => PRECEDENCE_LADDER[precedenceRung({ source, type })];
    assert.equal(rung('canonical'), 'canonical_identity');
    assert.equal(rung('live_intelligence'), 'community_state');
    assert.equal(rung('provider'), 'approved_provider_state');
    assert.equal(rung('recent'), 'cached_historical_state');
    assert.equal(rung('memory'), 'cached_historical_state');
    assert.equal(rung('local', 'completion'), 'user_raw_input');
    assert.equal(rung('ai', 'ai_suggestion'), 'ai_guess');
    assert.ok(precedenceRung({ source: 'canonical', type: 'entity' }) < precedenceRung({ source: 'provider', type: 'entity' }));
  });

  it('canonical identity beats approved provider state in EITHER arrival order', () => {
    const canon = { id: 'c', source: 'canonical' as const, type: 'entity' as const };
    const prov = { id: 'p', source: 'provider' as const, type: 'entity' as const };
    const same = () => 'same' as const;
    assert.deepEqual(resolveByPrecedence([prov, canon], same).map((r) => r.id), ['c']);
    assert.deepEqual(resolveByPrecedence([canon, prov], same).map((r) => r.id), ['c']);
  });

  it('down the whole ladder, the lower rung loses to every higher one', () => {
    const rows = [
      { id: 'ai', source: 'ai' as const, type: 'ai_suggestion' as const },
      { id: 'raw', source: 'local' as const, type: 'completion' as const },
      { id: 'cached', source: 'memory' as const, type: 'entity' as const },
      { id: 'prov', source: 'provider' as const, type: 'entity' as const },
      { id: 'community', source: 'live_intelligence' as const, type: 'entity' as const },
      { id: 'canon', source: 'canonical' as const, type: 'entity' as const },
    ];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const lower = rows[i], higher = rows[j];
        assert.deepEqual(resolveByPrecedence([lower, higher], () => 'same').map((r) => r.id), [higher.id], `${higher.id} > ${lower.id}`);
      }
    }
  });

  it('rows about different entities, or an uncertain match, are all kept', () => {
    const canon = { id: 'c', source: 'canonical' as const, type: 'entity' as const };
    const prov = { id: 'p', source: 'provider' as const, type: 'entity' as const };
    assert.deepEqual(resolveByPrecedence([prov, canon], () => 'distinct').map((r) => r.id), ['p', 'c']);
    assert.deepEqual(resolveByPrecedence([prov, canon], () => 'uncertain').map((r) => r.id), ['p', 'c']);
  });

  it('uncertain identity on the same rung is shown as choices, not resolved by invention', async () => {
    const A = fakeAdapter('a_src', [cand2('a1', 'Hai Cafe', DA_NANG_AT)]);
    const B = fakeAdapter('b_src', [cand2('b1', 'Hai Cafe', east(DA_NANG_AT, 0.6))]);
    const out = await federateProviderCandidates(providerWorld({ flagOn: true }).client, { q: 'Hai Cafe', scope: { kind: 'near', ...DA_NANG_AT }, origin: DA_NANG_AT, adapters: [A, B], limit: 5 });
    assert.equal(out.length, 2, 'two providers, one name, 600 m apart: both are offered');
  });
});

function cand2(id: string, name: string, at: { lat: number; lng: number }, over: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return { provider: 'x', providerPlaceId: id, name, lat: at.lat, lng: at.lng, locality: 'Da Nang', region: null, countryCode: 'VN', address: null, category: null, ...over };
}
function fakeAdapter(key: string, rows: ProviderCandidate[]): ProviderAdapter {
  return {
    key, flag: 'fsq_places_enabled', isApproved: async () => true, attribution: `From ${key}`, placeIdPrefix: key,
    search: async () => rows.map((r) => ({ ...r, provider: key })),
  };
}

describe('§36 G237 — provider neutrality: no source is favoured for being integrated first', () => {
  const sc = () => providerWorld({ flagOn: true }).client;
  const scope = { kind: 'near' as const, ...DA_NANG_AT };
  const run = (adapters: ProviderAdapter[], q: string) =>
    federateProviderCandidates(sc(), { q, scope, origin: DA_NANG_AT, adapters, limit: 10 });

  it('registration order does not decide: [A, B] and [B, A] federate to the identical list', async () => {
    const A = fakeAdapter('a_src', [cand2('a1', 'Moon Bar', east(DA_NANG_AT, 2)), cand2('a2', 'Moonlight Club', east(DA_NANG_AT, 1))]);
    const B = fakeAdapter('b_src', [cand2('b1', 'Moon', east(DA_NANG_AT, 3)), cand2('b2', 'Blue Moon', east(DA_NANG_AT, 0.5))]);
    const ab = await run([A, B], 'Moon');
    const ba = await run([B, A], 'Moon');
    assert.deepEqual(ab, ba);
  });

  it('a better match from the LATER-registered source leads', async () => {
    const A = fakeAdapter('a_src', [cand2('a1', 'Old Moon Bar', DA_NANG_AT)]);
    const B = fakeAdapter('b_src', [cand2('b1', 'Moon', east(DA_NANG_AT, 4))]);
    const out = await run([A, B], 'Moon');
    assert.equal(out[0].provider, 'b_src', 'an exact name match outranks a contains match, whoever was integrated first');
  });

  it('the provider key is never read: renaming the sources changes nothing about the order', async () => {
    const rows = [cand2('1', 'Moon Bar', east(DA_NANG_AT, 1)), cand2('2', 'Moonrise', east(DA_NANG_AT, 1))];
    const one = await run([fakeAdapter('aaa', [rows[0]]), fakeAdapter('zzz', [rows[1]])], 'Moon');
    const two = await run([fakeAdapter('zzz', [rows[0]]), fakeAdapter('aaa', [rows[1]])], 'Moon');
    assert.deepEqual(one.map((c) => c.providerPlaceId), two.map((c) => c.providerPlaceId));
  });

  it('two sources\' identical rows score identically, and the same venue is offered once', async () => {
    const A = fakeAdapter('a_src', [cand2('same-a', 'Han Market', DA_NANG_AT)]);
    const B = fakeAdapter('b_src', [cand2('same-b', 'Han Market', DA_NANG_AT)]);
    const ab = await run([A, B], 'Han Market');
    const ba = await run([B, A], 'Han Market');
    assert.equal(ab.length, 1, 'one venue, two sources: offered once');
    assert.deepEqual(ab, ba, 'and which source\'s record survives does not depend on order');
  });
});

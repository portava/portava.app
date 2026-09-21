/**
 * Phase 5 — Creation backend: constraint-aware suggestions + real duplicate
 * detection + the §23 validation suite, wired through the Phase-1 gateway.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceCreation.test.ts
 *
 * Style: direct calls into the gateway + the creation cores with an injected
 * fake client (no HTTP listener), mirroring inputAssistanceSocialIdentity.test.ts.
 *
 * Proves:
 *   - creating a Gem whose name+location matches an existing one surfaces the
 *     existing record as a `disambiguation` (§20/§55);
 *   - the same for a canonical Place (via the reused isSamePlace decision);
 *   - a duplicate is SUGGESTED, never auto-created / auto-merged (§20/§37) — the
 *     row opens the existing entity and sits in the medium confidence band;
 *   - a city-country mismatch yields a `correction` (§23);
 *   - a trip date conflict (overlap AND inverted range) yields a `validation`
 *     row that preserves user control (§23);
 *   - the constraint filter REMOVES a blocked/ineligible option and DEMOTES an
 *     out-of-window / out-of-city option before ranking (§20);
 *   - an unresolved location offers §37 fallback actions;
 *   - every returned row is resolvable (§13 no dead rows);
 *   - dedup degrades to [] on empty tables (pre-launch);
 *   - the admin getDuplicateCandidates stub is replaced by REAL matching.
 *
 * MUTATION-PROOFS (documented inline; each verified by hand):
 *   A. duplicateDetection.scoreGemDuplicate — replacing its body with `return 0`
 *      makes "existing Gem surfaced as disambiguation" + the scoreGemDuplicate
 *      unit test RED (dedup stops finding anything).
 *   B. creation.filterInfeasibleCandidates — replacing
 *        `(soft ? demoted : feasible).push(c)` with `feasible.push(c)` makes the
 *      "out-of-window option demoted last" test RED; removing the hard-infeasible
 *      `if (c.blocked ...) continue;` makes the "blocked option removed" test RED.
 *   C. validationSuite.checkCityCountryMismatch — returning `{ ok: true, ... }`
 *      unconditionally makes the "city-country mismatch → correction" test RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy, POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";
import {
  scoreGemDuplicate,
  findDuplicateGems,
  findDuplicatePlaces,
  findDuplicateEvents,
  scanDuplicateGems,
  scanDuplicatePlaces,
  scanDuplicateEvents,
  DUPLICATE_THRESHOLD,
  type DedupEntity,
} from "../lib/inputAssistance/duplicateDetection.js";
import {
  checkCityCountryMismatch,
  checkTripDateConflict,
  checkHashtagValidity,
} from "../lib/inputAssistance/validationSuite.js";
import {
  filterInfeasibleCandidates,
  getCreationDraftContexts,
  buildCreationAssistance,
  buildUnresolvedAddress,
  DUPLICATE_SCAN_UNREADABLE_POLICY_GAP,
} from "../lib/inputAssistance/creation.js";
import { isResolvable } from "../lib/inputAssistance/projection.js";
import { getDuplicateCandidates } from "../services/hiddenGems/HiddenGemModerationService.js";
import type { InputContext, CreationDraft } from "../lib/inputAssistance/types.js";

const ME = "aa000000-0000-4000-a000-000000000001";

// ── Fake Supabase client (P4 harness shape + `.not(col,'in',list)`) ─────────────

interface FakeState { [key: string]: any[] | undefined }

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  const errorFns = ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"];
  for (const fn of errorFns) errorBuilder[fn] = () => errorBuilder;
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

  return {
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;

      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;

      const builder: any = {
        select() { return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") { filters.push((r) => r[col] !== val && r[col] != null); return builder; }
          if (op === "in") {
            // val looks like "(a,b,c)" — exclude any row whose cell is in the list.
            const list = String(val).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
            filters.push((r) => !list.includes(String(r[col] ?? "")));
            return builder;
          }
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined);
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function gen(
  sc: any,
  context: InputContext,
  text: string,
  opts: { draft?: CreationDraft; city?: string | null; lat?: number | null; lng?: number | null } = {},
) {
  const policy = resolvePolicy(context)!;
  return generateSuggestions(sc, {
    context,
    policy,
    text,
    userId: ME,
    limit: policy.maxSuggestions,
    draft: opts.draft,
    city: opts.city ?? null,
    lat: opts.lat ?? null,
    lng: opts.lng ?? null,
  });
}

function gemRow(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, category: "cafe", city: "Da Nang", country: "Vietnam",
    latitude: 16.0678, longitude: 108.221, sensitivity_level: "public",
    status: "active", submitted_by: "zz000000-0000-4000-a000-000000000099",
    report_count: 0, created_at: "2026-01-01T00:00:00Z", ...extra,
  };
}

// Empty tables the gateway entity-path touches, so nothing errors → fail-open path.
function baseTables(extra: FakeState = {}): FakeState {
  return {
    blocks: [], user_privacy_settings: [], profiles: [],
    hidden_gems: [], places: [], events: [], trip_members: [], trips: [], hashtags: [],
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. scoreGemDuplicate — the pure dedup core (MUTATION-PROOF A target)
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreGemDuplicate (§20/§36 dedup core)", () => {
  const existing: DedupEntity = {
    id: "g1", name: "Sky Cafe", city: "Da Nang", country: "Vietnam",
    category: "cafe", lat: 16.0678, lng: 108.221,
  };

  it("same folded name at the same spot scores a strong duplicate", () => {
    const s = scoreGemDuplicate(
      { name: "sky cafe", city: "Da Nang", lat: 16.0679, lng: 108.2211 }, existing,
    );
    assert.ok(s >= 0.85, `expected strong duplicate, got ${s}`);
  });

  it("folds diacritics/strokes so 'Đà Nẵng' city matches 'Da Nang'", () => {
    const s = scoreGemDuplicate(
      { name: "Sky Cafe", city: "Đà Nẵng", lat: null, lng: null },
      { ...existing, lat: null, lng: null },
    );
    assert.ok(s >= DUPLICATE_THRESHOLD, `folded city+name should be a duplicate, got ${s}`);
  });

  it("the SAME name far away is NOT a duplicate (different real-world place)", () => {
    const s = scoreGemDuplicate(
      { name: "Sky Cafe", city: "Bangkok", lat: 13.7563, lng: 100.5018 }, existing,
    );
    assert.equal(s, 0, "a same-named cafe 1000km away is a different place");
  });

  it("a clearly different name is never a duplicate", () => {
    const s = scoreGemDuplicate(
      { name: "Ocean Ramen House", city: "Da Nang", lat: 16.0678, lng: 108.221 }, existing,
    );
    assert.ok(s < DUPLICATE_THRESHOLD, `different name should not surface, got ${s}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. findDuplicateGems / findDuplicatePlaces — DB-backed finders
// ─────────────────────────────────────────────────────────────────────────────

describe("findDuplicateGems (§20/§55)", () => {
  it("surfaces an existing gem that matches name + location", async () => {
    const sc = makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Sky Cafe")] }));
    const matches = await findDuplicateGems(sc as any, {
      name: "Sky Cafe", city: "Da Nang", lat: 16.0678, lng: 108.221,
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.entity.id, "g1");
    assert.ok(matches[0]!.score >= DUPLICATE_THRESHOLD);
  });

  it("returns [] gracefully when the table is empty (pre-launch)", async () => {
    const sc = makeFakeClient(baseTables());
    const matches = await findDuplicateGems(sc as any, { name: "Sky Cafe", city: "Da Nang" });
    assert.deepEqual(matches, []);
  });

  it("returns [] when the gems table errors (fail-soft, never throws)", async () => {
    const sc = makeFakeClient(baseTables(), new Set(["hidden_gems"]));
    const matches = await findDuplicateGems(sc as any, { name: "Sky Cafe", city: "Da Nang" });
    assert.deepEqual(matches, []);
  });
});

describe("findDuplicatePlaces (§23 canonical-Place-first)", () => {
  it("surfaces an existing place at the same coordinates (reuses isSamePlace)", async () => {
    const sc = makeFakeClient(baseTables({
      places: [{ id: "p1", name: "Sky Bar", city: "Da Nang", country: "Vietnam",
        primary_category: "bar", latitude: 16.0678, longitude: 108.221 }],
    }));
    const matches = await findDuplicatePlaces(sc as any, {
      name: "Sky Bar", city: "Da Nang", category: "bar", lat: 16.06781, lng: 108.22101,
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.entity.id, "p1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Gateway integration — duplicate surfaced as disambiguation (MUTATION-PROOF A)
// ─────────────────────────────────────────────────────────────────────────────

describe("hidden_gem_name — existing Gem surfaced as disambiguation (§20/§55)", () => {
  it("creating a gem whose name+location matches an existing one surfaces it", async () => {
    const sc = makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Sky Cafe")] }));
    const out = await gen(sc, "hidden_gem_name", "Sky Cafe", {
      city: "Da Nang", lat: 16.0678, lng: 108.221,
      draft: { city: "Da Nang", country: "Vietnam", lat: 16.0678, lng: 108.221 },
    });
    const dup = out.find((s) => s.type === "disambiguation" && s.entityId === "g1");
    assert.ok(dup, "the existing gem must be surfaced as a disambiguation");
    assert.equal(dup!.entityType, "hidden_gem");
    assert.equal(dup!.policyVersion, POLICY_VERSION);
    // §20/§37: SUGGEST only — opens the existing entity, never a create/merge.
    assert.equal(dup!.action?.type, "open_entity");
    // §42: projection must not leak raw internal fields.
    for (const forbidden of ["latitude", "longitude", "submitted_by", "report_count", "sensitivity_level"]) {
      assert.ok(!(forbidden in (dup as any)), `must not expose ${forbidden}`);
    }
  });

  it("shows a single row for a matched entity: the disambiguation, not also a plain entity (§20)", async () => {
    // Active submitter → the entity dispatch ALSO returns g1; the creation merge
    // must drop the redundant plain-entity row in favor of the disambiguation.
    const submitter = "zz000000-0000-4000-a000-000000000099";
    const sc = makeFakeClient(baseTables({
      hidden_gems: [gemRow("g1", "Sky Cafe")],
      profiles: [{ id: submitter, account_status: "active" }],
    }));
    const out = await gen(sc, "hidden_gem_name", "Sky Cafe", {
      city: "Da Nang", lat: 16.0678, lng: 108.221,
      draft: { city: "Da Nang", lat: 16.0678, lng: 108.221 },
    });
    const rowsForG1 = out.filter((s) => s.entityId === "g1");
    assert.equal(rowsForG1.length, 1, "the existing gem must appear exactly once");
    assert.equal(rowsForG1[0]!.type, "disambiguation", "and it must be the disambiguation");
  });

  it("does NOT surface a duplicate when no existing gem matches (no false positive)", async () => {
    const sc = makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Totally Different Spot")] }));
    const out = await gen(sc, "hidden_gem_name", "Sky Cafe", {
      city: "Da Nang", draft: { city: "Da Nang" },
    });
    assert.ok(!out.some((s) => s.type === "disambiguation"), "unrelated gem must not be surfaced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. "Duplicate does not silently auto-create" (§20/§37)
// ─────────────────────────────────────────────────────────────────────────────

describe("duplicate is SUGGESTED, never auto-created/auto-merged (§20/§37)", () => {
  it("the duplicate row opens the existing entity and stays medium confidence", async () => {
    const sc = makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Sky Cafe")] }));
    const out = await gen(sc, "hidden_gem_name", "Sky Cafe", {
      city: "Da Nang", lat: 16.0678, lng: 108.221,
      draft: { city: "Da Nang", lat: 16.0678, lng: 108.221 },
    });
    const dup = out.find((s) => s.type === "disambiguation");
    assert.ok(dup, "a duplicate should be surfaced");
    // Never an auto-replace (§19 medium band) and never a create/merge action.
    assert.ok((dup!.confidence ?? 1) <= 0.75, "duplicate must not be auto-replace confidence");
    assert.notEqual((dup!.action as any)?.type, "set_structured_value");
    const structured = dup!.structuredValue as any;
    assert.equal(structured?.kind, "resolve_existing", "carries a resolve-existing hint, not a create");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. City-country mismatch → correction (§23) (MUTATION-PROOF C)
// ─────────────────────────────────────────────────────────────────────────────

describe("checkCityCountryMismatch (§23)", () => {
  it("flags a city in a different country than typed", () => {
    const v = checkCityCountryMismatch({ city: "Da Nang", country: "Thailand" });
    assert.equal(v.ok, false);
    assert.equal(v.canonicalCountryCode, "VN");
  });
  it("accepts the correct country", () => {
    const v = checkCityCountryMismatch({ city: "Da Nang", country: "Vietnam" });
    assert.equal(v.ok, true);
  });
  it("never fabricates a mismatch for an unknown city", () => {
    const v = checkCityCountryMismatch({ city: "Nowheresville", country: "Thailand" });
    assert.equal(v.ok, true);
  });
});

describe("hidden_gem_name — city-country mismatch yields a correction (§23)", () => {
  it("a Da Nang gem typed with country Thailand surfaces a correction", async () => {
    const sc = makeFakeClient(baseTables());
    const out = await gen(sc, "hidden_gem_name", "Some New Gem", {
      draft: { city: "Da Nang", country: "Thailand" },
    });
    const corr = out.find((s) => s.type === "correction");
    assert.ok(corr, "a city-country correction should be surfaced");
    const val = (corr!.action as any).value;
    assert.equal(val.kind, "city_country_correction");
    assert.equal(val.countryCode, "VN", "suggests the canonical country");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Trip date conflict → validation (§23)
// ─────────────────────────────────────────────────────────────────────────────

describe("checkTripDateConflict (§23)", () => {
  const existing = [{ id: "t1", title: "Bangkok Week", startDate: "2026-03-10", endDate: "2026-03-20" }];
  it("detects an overlapping window", () => {
    const v = checkTripDateConflict({ startDate: "2026-03-15", endDate: "2026-03-25" }, existing);
    assert.equal(v.ok, false);
    assert.equal(v.kind, "overlap");
    assert.equal(v.conflictsWith?.id, "t1");
  });
  it("detects an inverted range", () => {
    const v = checkTripDateConflict({ startDate: "2026-04-10", endDate: "2026-04-01" }, existing);
    assert.equal(v.ok, false);
    assert.equal(v.kind, "inverted_range");
  });
  it("accepts a non-overlapping window", () => {
    const v = checkTripDateConflict({ startDate: "2026-05-01", endDate: "2026-05-10" }, existing);
    assert.equal(v.ok, true);
  });
});

describe("trip_title — overlapping trip dates yield a validation row (§23)", () => {
  it("surfaces the conflict without changing the dates (user control preserved)", async () => {
    const sc = makeFakeClient(baseTables({
      trip_members: [{ trip_id: "t1", role: "owner", user_id: ME }],
      trips: [{ id: "t1", title: "Bangkok Week", start_date: "2026-03-10", end_date: "2026-03-20", status: "upcoming" }],
    }));
    const out = await gen(sc, "trip_title", "Spring Escape", {
      draft: { startDate: "2026-03-15", endDate: "2026-03-25" },
    });
    const v = out.find((s) => s.type === "validation");
    assert.ok(v, "a trip date-conflict validation should be surfaced");
    assert.equal((v!.action as any).value.kind, "trip_date_conflict");
    assert.equal((v!.action as any).value.conflictsWithTripId, "t1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Constraint-aware filtering (§20) (MUTATION-PROOF B)
// ─────────────────────────────────────────────────────────────────────────────

describe("filterInfeasibleCandidates (§20)", () => {
  it("REMOVES a blocked/ineligible option entirely", () => {
    const out = filterInfeasibleCandidates([
      { item: "ok", city: "Da Nang" },
      { item: "blocked", city: "Da Nang", blocked: true },
    ], { city: "Da Nang" });
    const items = out.map((c) => c.item);
    assert.ok(items.includes("ok"));
    assert.ok(!items.includes("blocked"), "a blocked option must be removed");
  });

  it("REMOVES a sensitive-exact protected location", () => {
    const out = filterInfeasibleCandidates([
      { item: "ok" },
      { item: "protected", sensitiveExact: true },
    ]);
    assert.ok(!out.map((c) => c.item).includes("protected"));
  });

  it("DEMOTES an out-of-window option to last", () => {
    const out = filterInfeasibleCandidates([
      { item: "past", startsAt: "2026-01-01T00:00:00Z" },
      { item: "inWindow", startsAt: "2026-03-15T00:00:00Z" },
    ], { windowStart: "2026-03-01T00:00:00Z", windowEnd: "2026-03-31T00:00:00Z" });
    assert.deepEqual(out.map((c) => c.item), ["inWindow", "past"], "in-window leads, out-of-window trails");
  });

  it("DEMOTES an out-of-city option to last", () => {
    const out = filterInfeasibleCandidates([
      { item: "elsewhere", city: "Bangkok" },
      { item: "here", city: "Da Nang" },
    ], { city: "Da Nang" });
    assert.deepEqual(out.map((c) => c.item), ["here", "elsewhere"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Unresolved address fallbacks (§23/§37)
// ─────────────────────────────────────────────────────────────────────────────

describe("event_location — unresolved address offers §37 fallbacks", () => {
  it("offers drop-pin / nearby / raw when nothing canonical resolves", async () => {
    const sc = makeFakeClient(baseTables());
    const out = await gen(sc, "event_location", "Some Unlisted Alley Spot", {
      city: "Da Nang", draft: { city: "Da Nang" },
    });
    assert.ok(out.some((s) => s.action?.type === "drop_pin"), "a drop-pin fallback should be offered");
    assert.ok(out.some((s) => (s.action as any)?.type === "submit_search"), "a search-nearby fallback should be offered");
  });
});

describe("city_picker never offers a create/drop-pin fallback (§37 context-dependent)", () => {
  it("a canonical city picker yields no fallback actions on no-match", async () => {
    const sc = makeFakeClient(baseTables());
    const out = await gen(sc, "city_picker", "Xzqwptown", { city: null });
    assert.ok(!out.some((s) => s.action?.type === "drop_pin"), "a city picker must not offer drop-pin");
  });
});

// ── §37 NEW-ENTITY CREATION (census G240) ────────────────────────────────────
// The row's complaint, verbatim: "Map-point and raw-text fallbacks exist.
// NEW-ENTITY CREATION DOES NOT: nothing emits an 'Add a new Place'/'Add a new
// Gem' row, so the spec's own empty-state mock cannot be rendered from platform
// output." The mock is
//   [Search instead][Drop a pin][Add a new Place][Ask Compass][Search nearby]
// and these tests assert the third element exists, carries a resolvable §43
// action, and is still refused for the picker §37 names as the counter-example.
//
// MUTATION-PROOFS (each applied, watched go red, reverted):
//   - creation.ts: pass `createEntity: null` unconditionally
//       → "offers Add a new Place" and "offers Add a new Gem" go red.
//   - creation.ts: drop the `policy.entityTypes.includes(...)` half of the gate
//       → "a policy that does not name the entity type offers no creation" red.
//   - creation.ts: add `city_picker` to CREATABLE_ENTITY_BY_CONTEXT *and* to
//     ADDRESS_FALLBACK_CONTEXTS → the city-picker refusal below STAYS GREEN.
//     Recorded rather than hidden: `city_picker`'s policy declares no `action`
//     type, so `canAction` refuses before either of the other two gates is
//     consulted. That is §12.5's "one gate masked another" — the refusal is
//     real and mutation-proof through the POLICY, and the context map is a
//     second, currently-unobservable gate for that context. The gate that IS
//     observable is the entityTypes one, pinned by "under policy" below.
function createRows(out: any[]) {
  return out.filter(
    (s) => (s.action as any)?.type === "set_structured_value"
      && (s.action as any)?.value?.kind === "create_entity",
  );
}

describe("§37 new-entity creation under policy (G240)", () => {
  it("event_location offers 'Add a new Place' when nothing canonical resolves", async () => {
    const sc = makeFakeClient(baseTables());
    const out = await gen(sc, "event_location", "Some Unlisted Alley Spot", {
      city: "Da Nang", draft: { city: "Da Nang" },
    });
    const rows = createRows(out);
    assert.equal(rows.length, 1, "exactly one creation row");
    assert.equal(rows[0].label, "Add a new Place");
    assert.equal((rows[0].action as any).value.entityType, "place");
    assert.equal((rows[0].action as any).value.name, "Some Unlisted Alley Spot");
    // §13 — it is not a dead row.
    assert.ok(rows[0].action != null);
  });

  it("hidden_gem_location offers 'Add a new Gem', not 'Add a new Place'", async () => {
    const sc = makeFakeClient(baseTables());
    const out = await gen(sc, "hidden_gem_location", "Unlisted Rooftop Ladder", {
      city: "Da Nang", draft: { city: "Da Nang" },
    });
    const rows = createRows(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, "Add a new Gem");
    assert.equal((rows[0].action as any).value.entityType, "hidden_gem");
  });

  it("a city picker still offers NO creation row (§37's own counter-example)", async () => {
    const sc = makeFakeClient(baseTables());
    const out = await gen(sc, "city_picker", "Xzqwptown", { city: null });
    assert.equal(createRows(out).length, 0, "a city picker must not offer 'create city'");
  });

  it("the creation row is UNDER POLICY: a policy that does not name the entity type offers none", () => {
    const policy = resolvePolicy("hidden_gem_location");
    // Same context, same text — only the policy's declared entityTypes change.
    const withGem = buildUnresolvedAddress("hidden_gem_location", policy, POLICY_VERSION, "Unlisted Rooftop");
    const withoutGem = buildUnresolvedAddress(
      "hidden_gem_location",
      { ...policy, entityTypes: (policy.entityTypes ?? []).filter((e) => e !== "hidden_gem") },
      POLICY_VERSION,
      "Unlisted Rooftop",
    );
    assert.equal(createRows(withGem).length, 1);
    assert.equal(createRows(withoutGem).length, 0);
    // and nothing ELSE changed — the other fallbacks are untouched by the gate
    assert.equal(
      withGem.filter((s) => s.action?.type === "drop_pin").length,
      withoutGem.filter((s) => s.action?.type === "drop_pin").length,
    );
  });

  it("an empty query produces no creation row (nothing to name)", () => {
    const policy = resolvePolicy("place_picker");
    assert.equal(createRows(buildUnresolvedAddress("place_picker", policy, POLICY_VERSION, "   ")).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. No dead rows (§13) — every returned suggestion is resolvable
// ─────────────────────────────────────────────────────────────────────────────

describe("creation rows are all resolvable (§13)", () => {
  it("every row from a rich creation request resolves to something actionable", async () => {
    const sc = makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Sky Cafe")] }));
    const out = await gen(sc, "hidden_gem_name", "Sky Cafe", {
      city: "Da Nang", lat: 16.0678, lng: 108.221,
      draft: { city: "Da Nang", country: "Thailand", lat: 16.0678, lng: 108.221 },
    });
    assert.ok(out.length > 0, "the request should produce rows");
    for (const s of out) assert.ok(isResolvable(s), `row ${s.id} must be resolvable`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Hashtag validity (§23) + context wiring sanity
// ─────────────────────────────────────────────────────────────────────────────

describe("checkHashtagValidity (§23)", () => {
  it("accepts an already-canonical tag (case-only differences are not a correction)", () => {
    assert.equal(checkHashtagValidity("food").ok, true);
    assert.equal(checkHashtagValidity("#Food").ok, true); // display keeps case; slug is lowercase
  });
  it("proposes a normalized slug when the body actually changes", () => {
    const v = checkHashtagValidity("#food-truck"); // stops at the hyphen → "food"
    assert.equal(v.ok, false);
    assert.equal(v.slug, "food");
  });
  it("rejects an unusable tag body", () => {
    assert.equal(checkHashtagValidity("#!").slug, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Admin stub replacement — getDuplicateCandidates now does REAL matching
// ─────────────────────────────────────────────────────────────────────────────

describe("getDuplicateCandidates — real duplicate matching (stub replaced)", () => {
  it("returns only pending gems that truly duplicate an active one, annotated", async () => {
    const sc = makeFakeClient({
      hidden_gems: [
        gemRow("active1", "Sky Cafe", { status: "active" }),
        gemRow("pendingDup", "sky cafe", { status: "pending", latitude: 16.0679, longitude: 108.2211 }),
        gemRow("pendingUnique", "Lonely Rooftop", { status: "pending", latitude: 10.0, longitude: 20.0, city: "Manila" }),
      ],
    });
    const out = await getDuplicateCandidates(sc as any);
    const ids = out.map((g: any) => g.id);
    assert.ok(ids.includes("pendingDup"), "a real duplicate pending gem must be flagged");
    assert.ok(!ids.includes("pendingUnique"), "a unique pending gem must NOT be flagged");
    const flagged = out.find((g: any) => g.id === "pendingDup");
    assert.equal(flagged.duplicateOf?.id, "active1", "annotated with the record it collides with");
  });

  it("returns [] when there are no active gems to collide with (empty pool)", async () => {
    const sc = makeFakeClient({
      hidden_gems: [gemRow("pendingOnly", "Sky Cafe", { status: "pending" })],
    });
    const out = await getDuplicateCandidates(sc as any);
    assert.deepEqual(out, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Creation draft context surface (registry sanity)
// ─────────────────────────────────────────────────────────────────────────────

describe("creation context registry", () => {
  it("exposes the creation contexts that read the draft", () => {
    const ctxs = getCreationDraftContexts();
    assert.ok(ctxs.includes("hidden_gem_name"));
    assert.ok(ctxs.includes("event_title"));
    assert.ok(ctxs.includes("trip_title"));
  });
});

// ── D11 / swallowed-read inventory: the three duplicate-candidate reads ───────
//
// Sites (docs/architecture/swallowed-read-inventory.md):
//   duplicateDetection.ts:215  fetchGemCandidates      — COMMENTED
//   duplicateDetection.ts:306  findDuplicatePlaces     — SILENT
//   duplicateDetection.ts:411  findDuplicateEvents     — SILENT
// All three were `if (error || !data) return []`, byte-identical to the [] a
// genuinely empty candidate pool returns.
//
// Owner's question — may the caller act on this emptiness as if it were an
// answer? NO. creation.ts:286/294/301 turns these matches into `disambiguation`
// rows; NO rows is rendered to a traveller as "nothing like this exists yet",
// and they act on it by creating the duplicate. duplicateDetection.ts's own
// comments record two production outages of exactly that (a 22P02 on
// `status:'approved'`, a PGRST100 on a `country` column) in which "a traveller
// submitting a Hidden Gem was never shown 'this may already exist' — not even
// for an identical name at identical coordinates".
//
// The FIX keeps the fail-closed direction and every existing contract: the
// legacy `findDuplicate*` entry points still resolve to [] and still never
// throw (the guards above depend on that), and the honest answer is available
// through `scanDuplicate*`, which returns the tree's local discriminated shape
// { ok: true; matches } | { ok: false; reason }. Two absences no longer read
// alike for a caller that asks.

describe("D11: a duplicate-candidate pool that could not be read is not an empty one", () => {
  it("scanDuplicateGems distinguishes an unreadable hidden_gems from a genuinely empty one", async () => {
    const empty = await scanDuplicateGems(
      makeFakeClient(baseTables()) as any, { name: "Sky Cafe", city: "Da Nang" },
    );
    assert.deepEqual(empty, { ok: true, matches: [] }, "a genuine miss is an answer");

    const unread = await scanDuplicateGems(
      makeFakeClient(baseTables(), new Set(["hidden_gems"])) as any,
      { name: "Sky Cafe", city: "Da Nang" },
    );
    assert.equal(unread.ok, false, "an unreadable candidate pool must not answer 'no duplicates'");
    assert.notDeepEqual(unread, empty, "the two absences must not read alike");
    if (!unread.ok) {
      assert.equal(unread.reason, "candidate_pool_unreadable");
      assert.equal(unread.table, "hidden_gems");
    }
  });

  it("scanDuplicatePlaces distinguishes an unreadable places from a genuinely empty one", async () => {
    const empty = await scanDuplicatePlaces(
      makeFakeClient(baseTables()) as any, { name: "Sky Bar", city: "Da Nang" },
    );
    assert.deepEqual(empty, { ok: true, matches: [] });

    const unread = await scanDuplicatePlaces(
      makeFakeClient(baseTables(), new Set(["places"])) as any, { name: "Sky Bar", city: "Da Nang" },
    );
    assert.equal(unread.ok, false);
    assert.notDeepEqual(unread, empty, "the two absences must not read alike");
    if (!unread.ok) assert.equal(unread.table, "places");
  });

  it("scanDuplicateEvents distinguishes an unreadable events from a genuinely empty one", async () => {
    const empty = await scanDuplicateEvents(
      makeFakeClient(baseTables()) as any, { name: "Full Moon Party", city: "Da Nang" },
    );
    assert.deepEqual(empty, { ok: true, matches: [] });

    const unread = await scanDuplicateEvents(
      makeFakeClient(baseTables(), new Set(["events"])) as any,
      { name: "Full Moon Party", city: "Da Nang" },
    );
    assert.equal(unread.ok, false);
    assert.notDeepEqual(unread, empty, "the two absences must not read alike");
    if (!unread.ok) assert.equal(unread.table, "events");
  });

  it("a healthy read still scans and scores normally", async () => {
    const scan = await scanDuplicateGems(
      makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Sky Cafe")] })) as any,
      { name: "Sky Cafe", city: "Da Nang", lat: 16.0678, lng: 108.221, category: "cafe" },
    );
    assert.equal(scan.ok, true);
    if (scan.ok) assert.equal(scan.matches.length, 1, "the real matcher still runs through the scan path");
  });

  it("the legacy fail-soft adapters keep their contract (still [], still never throw)", async () => {
    const sc = makeFakeClient(baseTables(), new Set(["hidden_gems", "places", "events"]));
    assert.deepEqual(await findDuplicateGems(sc as any, { name: "Sky Cafe", city: "Da Nang" }), []);
    assert.deepEqual(await findDuplicatePlaces(sc as any, { name: "Sky Bar", city: "Da Nang" }), []);
    assert.deepEqual(await findDuplicateEvents(sc as any, { name: "Full Moon", city: "Da Nang" }), []);
  });
});

// ── D11 LAST MILE: buildCreationAssistance is the caller the ruling names ─────
//
// `scanDuplicate*` (proved above) can SAY that a candidate pool was unreadable,
// but saying it changes nothing until the caller listens. Until this block,
// `buildCreationAssistance` consumed the fail-soft `findDuplicate*` adapters,
// which fold `{ ok: false }` straight back into the `[]` an empty pool returns —
// so the traveller's screen was byte-identical in both cases, and the absence of
// a "did you mean" row read as "nothing like this exists yet".
//
// The fix is NOT a block and NOT a log: creation still proceeds, nothing is
// auto-merged, and an unreadable pool still proposes zero duplicates. What
// changes is that the claim implied by zero rows is withdrawn on the wire, in
// the convention socialIdentity.buildRecipientsUnreadable already set for this
// exact class (a non-blocking `validation` row carrying a structured status).
//
// MUTATION: in creation.ts, change `take`'s else-branch to drop the table
// (`} else { /* nothing */ }`), or drop the `unreadable.length > 0` push — the
// first three tests below go RED.

const DUP_UNREADABLE = "candidate_pool_unreadable";

async function creationRows(
  sc: any,
  context: InputContext,
  text: string,
  draft: CreationDraft = {},
) {
  const policy = resolvePolicy(context)!;
  return buildCreationAssistance(sc as any, {
    context,
    policy,
    text,
    userId: ME,
    draft,
    viewerCity: "Da Nang",
    lat: null,
    lng: null,
    policyVersion: POLICY_VERSION,
    max: policy.maxSuggestions,
  });
}

describe("D11: creation assistance tells the traveller when the duplicate check did not run", () => {
  it("an unreadable hidden_gems pool no longer looks like 'nothing like this exists'", async () => {
    const empty = await creationRows(makeFakeClient(baseTables()), "hidden_gem_name", "Sky Cafe");
    const unread = await creationRows(
      makeFakeClient(baseTables(), new Set(["hidden_gems"])),
      "hidden_gem_name",
      "Sky Cafe",
    );

    assert.deepEqual(
      empty.filter((r) => r.reason === DUP_UNREADABLE),
      [],
      "a genuinely empty pool is an answer and must claim nothing",
    );

    const said = unread.filter((r) => r.reason === DUP_UNREADABLE);
    assert.equal(said.length, 1, "an unreadable pool must be stated exactly once");
    assert.equal(said[0]!.type, "validation", "it is a non-blocking validation row (§20/§37)");
    assert.deepEqual(
      (said[0]!.structuredValue as any).tables,
      ["hidden_gems"],
      "the row names the pool that could not be read",
    );
    assert.equal((said[0]!.structuredValue as any).available, false);
    assert.notDeepEqual(unread, empty, "the two absences must not read alike");
  });

  it("the row is resolvable, so §13 no-dead-rows keeps it, and it never blocks creation", async () => {
    const unread = await creationRows(
      makeFakeClient(baseTables(), new Set(["hidden_gems"])),
      "hidden_gem_name",
      "Sky Cafe",
    );
    const row = unread.find((r) => r.reason === DUP_UNREADABLE)!;
    assert.ok(isResolvable(row), "a row dropDeadRows would discard tells nobody anything");
    assert.equal(row.action?.type, "set_structured_value");
    assert.ok((row.confidence ?? 1) < 0.5, "never in the auto-replace band (§19)");
    assert.equal(
      unread.some((r) => r.type === "disambiguation"),
      false,
      "an unreadable pool still PROPOSES nothing — the fail-closed direction is unchanged",
    );
  });

  it("reaches the wire through the gateway, ranked and not dropped", async () => {
    const out = await gen(
      makeFakeClient(baseTables(), new Set(["hidden_gems"])),
      "hidden_gem_name",
      "Sky Cafe",
    );
    assert.equal(
      out.some((r) => r.reason === DUP_UNREADABLE),
      true,
      "the whole point is that the CALLER is told, not an operator",
    );
    for (const r of out) assert.ok(isResolvable(r), "§13: every returned row resolves");
  });

  it("a healthy pool that really matches still surfaces the duplicate, and says nothing extra", async () => {
    const out = await creationRows(
      makeFakeClient(baseTables({ hidden_gems: [gemRow("g1", "Sky Cafe")] })),
      "hidden_gem_name",
      "Sky Cafe",
    );
    assert.equal(
      out.filter((r) => r.type === "disambiguation").length,
      1,
      "the real matcher still runs through the scan path",
    );
    assert.equal(out.some((r) => r.reason === DUP_UNREADABLE), false);
  });

  it("the two contexts whose policy forbids `validation` are STILL silent — a stated gap, not a claim", async () => {
    assert.deepEqual([...DUPLICATE_SCAN_UNREADABLE_POLICY_GAP], ["trip_stop_place", "event_title"]);
    for (const context of DUPLICATE_SCAN_UNREADABLE_POLICY_GAP) {
      const policy = resolvePolicy(context)!;
      assert.equal(
        policy.allowedSuggestionTypes.includes("disambiguation"),
        true,
        `${context} runs duplicate detection`,
      );
      assert.equal(
        policy.allowedSuggestionTypes.includes("validation"),
        false,
        `${context} may not emit a validation row (§6) — this is why it stays silent`,
      );
    }
    const unread = await creationRows(
      makeFakeClient(baseTables(), new Set(["events"])),
      "event_title",
      "Full Moon Party",
    );
    assert.equal(
      unread.some((r) => r.reason === DUP_UNREADABLE),
      false,
      "documenting the gap honestly: event_title cannot carry the row under its §6 policy",
    );
  });
});

// ── SAME DEFECT CLASS, second site in this file: the viewer's trip windows ────
//
// Found while closing the three duplicate pools; it is NOT in
// docs/architecture/swallowed-read-inventory.md (that measurement admits it
// under-counts). `fetchViewerTripWindows` answered a failed `trip_members` or
// `trips` read with the same `[]` that means "you are on no other trip", and
// `checkTripDateConflict([])` returns `{ ok: true }` — so the field emitted no
// row, and no row on a date field reads as "your dates are clear". That is a
// POSITIVE claim about the traveller's other trips, made out of a read that
// never ran, on the exact question they were asking.
//
// MUTATION: in creation.ts, return `{ ok: true, windows: [] }` from either
// `windowsUnreadable` branch — the first two tests below go RED.

describe("D11: an unreadable trip list never becomes 'your dates are clear'", () => {
  const draft: CreationDraft = { startDate: "2026-03-15", endDate: "2026-03-25" };

  it("an unreadable trip_members withdraws the no-conflict claim instead of making it", async () => {
    const clear = await creationRows(
      makeFakeClient(baseTables()), "trip_title", "Spring Escape", draft,
    );
    const unread = await creationRows(
      makeFakeClient(baseTables(), new Set(["trip_members"])), "trip_title", "Spring Escape", draft,
    );

    assert.deepEqual(
      clear.filter((r) => r.reason === "trip_windows_unreadable"),
      [],
      "a traveller who is genuinely on no other trip is told nothing extra",
    );
    const said = unread.filter((r) => r.reason === "trip_windows_unreadable");
    assert.equal(said.length, 1);
    assert.equal(said[0]!.type, "validation");
    assert.equal((said[0]!.structuredValue as any).table, "trip_members");
    assert.notDeepEqual(unread, clear, "the two absences must not read alike");
  });

  it("an unreadable trips table is caught too — the second read, not just the first", async () => {
    const unread = await creationRows(
      makeFakeClient(
        baseTables({ trip_members: [{ trip_id: "t1", role: "owner", user_id: ME }] }),
        new Set(["trips"]),
      ),
      "trip_title",
      "Spring Escape",
      draft,
    );
    const said = unread.find((r) => r.reason === "trip_windows_unreadable");
    assert.ok(said, "the trips read is the one that carries the dates");
    assert.equal((said!.structuredValue as any).table, "trips");
    assert.equal(
      unread.some((r) => (r.structuredValue as any)?.kind === "trip_date_conflict"),
      false,
      "and it must not ALSO claim a specific conflict it never measured",
    );
  });

  it("a real conflict is still surfaced, and a real all-clear still says nothing", async () => {
    const conflict = await creationRows(
      makeFakeClient(baseTables({
        trip_members: [{ trip_id: "t1", role: "owner", user_id: ME }],
        trips: [{ id: "t1", title: "Bangkok Week", start_date: "2026-03-10", end_date: "2026-03-20", status: "upcoming" }],
      })),
      "trip_title", "Spring Escape", draft,
    );
    assert.equal(
      (conflict.find((r) => r.type === "validation")!.structuredValue as any).conflictsWithTripId,
      "t1",
      "the §23 validator still runs through the scan path",
    );

    const allClear = await creationRows(
      makeFakeClient(baseTables({
        trip_members: [{ trip_id: "t1", role: "owner", user_id: ME }],
        trips: [{ id: "t1", title: "Bangkok Week", start_date: "2026-06-10", end_date: "2026-06-20", status: "upcoming" }],
      })),
      "trip_title", "Spring Escape", draft,
    );
    assert.deepEqual(allClear, [], "a measured all-clear is still silent — that is the honest zero");
  });
});

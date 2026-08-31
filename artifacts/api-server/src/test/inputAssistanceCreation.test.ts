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

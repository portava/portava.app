/**
 * Global Input Intelligence — the invariants nothing was proving.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceInvariants.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A measured re-audit of the Input Intelligence lane mutation-probed 22 declared
 * invariants across the 15 backend modules against the existing 168-test suite.
 * Fourteen went RED (genuinely load-bearing). SEVEN stayed GREEN with the
 * production code reverted — the behaviour existed, was documented as a
 * guarantee, and NOTHING demonstrated it. Each of those seven is locked here,
 * and each assertion below carries the exact mutation that turns it RED.
 *
 *   1. §54/§29  recipient search reads `account_status = 'active'` only — a
 *               deactivated / pending-deletion / deleted account must never be
 *               offered as a Telegraph recipient.
 *   2. §26      hashtag references exclude `is_blocked` tags — a moderated tag
 *               must not come back as a structured reference.
 *   3. §23      username availability excludes the CALLER'S OWN row — otherwise
 *               a user re-typing their own handle is told it is taken.
 *   4. §9/§15   BOOST_CEILING: a personalized weaker match can never be lifted
 *               to or past the exact-match confidence band (augment, never
 *               override).
 *   5. §29/§35  SURFACEABLE_GEO_TYPES: personalization surfaces ONLY public
 *               canonical geo entities on its own. A remembered person/place is
 *               re-ranked among candidates that already passed the privacy gate,
 *               never injected around it — and never re-labelled as a city.
 *   6. §47      the gateway sanitizes the query (PostgREST filter metacharacters)
 *               before it reaches candidate generation and the emitted rows.
 *   7. §9       BOOSTABLE_TYPES: the selection boost touches real entity/recent/
 *               personalized rows only — never an `ai_suggestion` or `action`,
 *               which would let memory lift an AI guess over a canonical entity.
 *
 * NOT PROVABLE, AND SAID SO RATHER THAN FAKED: `MAX_BOOST` (0.25) is entirely
 * dominated by `BOOST_CEILING` on every reachable input — raising it to 9 leaves
 * all 168 existing tests AND every assertion below green, because the ceiling
 * clamps first. It is a tunable with no independently observable effect, not a
 * guarantee, so no test here pretends to pin it.
 *
 * Style: direct calls into the gateway + the resolvers with an injected fake
 * client (no HTTP listener), matching inputAssistanceSocialIdentity.test.ts.
 *
 * FIXTURE HONESTY: every literal this file feeds a filtered column is a real
 * value of that column per artifacts/api-server/baseline/20260819_baseline_structure.sql
 * — `profiles.account_status` CHECK (active | deactivated | pending_deletion |
 * deleted) and `hashtags.is_blocked` (boolean NOT NULL). The fake client answers
 * "is my fixture's value in the list you passed?", never "is your literal a real
 * label?", so a fixture that encoded a value the database cannot hold would make
 * these tests prove nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import {
  resolveRecipientSuggestions,
  resolveHashtagRefSuggestions,
  checkUsernameAvailability,
} from "../lib/inputAssistance/socialIdentity.js";
import {
  applyPriorSelectionBoost,
  buildLearnedGeoInjections,
  buildSelectionRecents,
  fetchSelectionMemory,
} from "../lib/inputAssistance/personalization.js";
import { projectSearchResult } from "../lib/inputAssistance/projection.js";
import { searchKey, normalizeLocationName } from "../lib/canonicalLocations.js";
import type { SearchResult } from "../routes/discoverySearch.js";
import type { InputContext, InputSuggestion } from "../lib/inputAssistance/types.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────

const ME = "aa000000-0000-4000-a000-00000000ee01";
const BOB = "bb000000-0000-4000-a000-00000000ee02"; // followed + active   → eligible
const GONE = "cc000000-0000-4000-a000-00000000ee03"; // followed + deactivated
const DELD = "dd000000-0000-4000-a000-00000000ee04"; // followed + deleted
const PEND = "ee000000-0000-4000-a000-00000000ee05"; // followed + pending_deletion

// ── Fake Supabase client (same harness shape as the sibling input suites) ───────

interface FakeState { [key: string]: any[] | undefined }

function makeFakeClient(state: FakeState) {
  return {
    from: (table: string) => {
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      let profileCols: string[] | null = null;
      function project(rowsIn: any[]): any[] {
        if (table !== "profiles" || !profileCols) return rowsIn;
        return rowsIn.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
      }
      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
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
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = project(sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined));
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Row builders ───────────────────────────────────────────────────────────────

/**
 * `account_status` values are exactly the four the baseline CHECK allows:
 *   profiles_account_status_check CHECK (account_status = ANY (ARRAY[
 *     'active', 'deactivated', 'pending_deletion', 'deleted']))
 * — so a fixture here can never encode a value PostgREST would reject.
 */
function profile(id: string, handle: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name, avatar_url: null, is_private: false,
    home_city: null, home_country: null, account_status: "active",
    verified: false, is_official: false, show_profile_picture_publicly: true, ...extra,
  };
}

function canonCity(name: string, id: string, country: string) {
  const key = searchKey(name);
  return {
    id,
    kind: "city",
    name,
    normalized_name: normalizeLocationName(name),
    search_key: key,
    display_name: `${name}, ${country}`,
    city: null, region: null, country, country_code: null, postal_code: null,
    lat: null, lng: null, provider_ids: {}, aliases: [],
  };
}

/** ME follows all four; nobody is blocked; everybody accepts messages. The ONLY
 *  thing separating them is `account_status`. */
function recipientState(): FakeState {
  return {
    profiles: [
      profile(BOB, "bob_traveler", "Bob"),
      profile(GONE, "gone_traveler", "Gone", { account_status: "deactivated" }),
      profile(DELD, "deld_traveler", "Deleted", { account_status: "deleted" }),
      profile(PEND, "pend_traveler", "Pending", { account_status: "pending_deletion" }),
    ],
    user_follows: [
      { follower_id: ME, following_id: BOB },
      { follower_id: ME, following_id: GONE },
      { follower_id: ME, following_id: DELD },
      { follower_id: ME, following_id: PEND },
    ],
    user_friendships: [],
    message_thread_members: [],
    trip_members: [],
    blocks: [],
    user_message_settings: [],
    circle_memberships: [],
  };
}

const POLICY_V = "test-policy";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. §54/§29 — recipient search is restricted to ACTIVE accounts
// ═══════════════════════════════════════════════════════════════════════════════

describe("telegraph_recipient — only ACTIVE accounts are offered (§54/§29)", () => {
  // MUTATION-PROOF: in socialIdentity.resolveRecipientSuggestions, delete
  //   .in('account_status', ['active'])
  // from the pooled-profile read. All three non-active accounts leak into the
  // recipient list and this test goes RED. (Verified: the 168-test suite alone
  // stays fully GREEN under that mutation — which is why this test exists.)
  it("a deactivated / deleted / pending-deletion contact is never a recipient", async () => {
    const sc = makeFakeClient(recipientState());
    const out = await resolveRecipientSuggestions(sc, "telegraph_recipient", POLICY_V, {
      userId: ME,
      q: "",
      max: 10,
    });
    const ids = new Set(out.map((s) => s.entityId));

    assert.ok(ids.has(BOB), "the ACTIVE contact must still appear — otherwise the assertion below is vacuous");
    for (const [id, status] of [[GONE, "deactivated"], [DELD, "deleted"], [PEND, "pending_deletion"]] as const) {
      assert.ok(!ids.has(id), `a ${status} account must never be offered as a recipient`);
    }
    assert.equal(out.length, 1, "exactly one of the four followed contacts is eligible");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. §26 — a moderated (blocked) hashtag is not a structured reference
// ═══════════════════════════════════════════════════════════════════════════════

describe("hashtag references — a blocked tag is never suggested (§26)", () => {
  // MUTATION-PROOF: in socialIdentity.searchExistingHashtags, delete
  //   .eq('is_blocked', false)
  // The blocked tag comes back as a canonical, usage-ranked reference and this
  // test goes RED.
  it("an is_blocked hashtag is excluded while a clean one on the same prefix survives", async () => {
    const sc = makeFakeClient({
      hashtags: [
        { id: "h-clean", slug: "surfclean", name: "surfclean", usage_count: 5, is_blocked: false },
        { id: "h-blocked", slug: "surfbanned", name: "surfbanned", usage_count: 9999, is_blocked: true },
      ],
    });
    const out = await resolveHashtagRefSuggestions(sc, "caption", POLICY_V, { raw: "#surf", max: 10 });
    const slugs = out.map((s) => (s.structuredValue as { slug?: string } | undefined)?.slug);

    assert.ok(slugs.includes("surfclean"), "the clean tag must appear — otherwise this test is vacuous");
    assert.ok(
      !slugs.includes("surfbanned"),
      "a blocked hashtag must not be returned as a structured reference, even though it ranks highest by usage",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. §23 — username availability excludes the caller's OWN row
// ═══════════════════════════════════════════════════════════════════════════════

describe("username validation — the caller's own handle is not 'taken' (§23)", () => {
  // MUTATION-PROOF: in socialIdentity.checkUsernameAvailability, delete
  //   .neq('id', userId)
  // The caller's own row matches, `data` is truthy, and the first assertion goes
  // RED with "Username is already taken".
  it("re-typing your own username reads AVAILABLE, while someone else's reads TAKEN", async () => {
    const sc = makeFakeClient({
      profiles: [
        profile(ME, "mine", "Me"),
        profile(BOB, "theirs", "Bob"),
      ],
    });

    const own = await checkUsernameAvailability(sc, "mine", ME);
    assert.equal(own.available, true, "a user's own handle must not be reported as taken");

    const other = await checkUsernameAvailability(sc, "theirs", ME);
    assert.equal(other.available, false, "another user's handle IS taken — proves the uniqueness query runs at all");
    assert.equal(other.reason, "Username is already taken");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. §9/§15 — the personalization ceiling: augment, never override
// ═══════════════════════════════════════════════════════════════════════════════

/** Build the memory shape `applyPriorSelectionBoost` consumes, without going
 *  through the DB — one entity selected `count` times via `queryKey`. */
function memoryFor(entityType: string, entityId: string, queryKey: string, count: number) {
  return {
    byEntity: new Map([[
      `${entityType}:${entityId}`,
      {
        entityType,
        entityId,
        total: count,
        byQuery: new Map([[queryKey, count]]),
        lastSelectedAt: "2026-09-01T00:00:00.000Z",
        label: "Remembered",
      },
    ]]),
    recentEntities: [],
    isEmpty: false,
  };
}

/**
 * The exact-match confidence band, DERIVED from the projector that produces it
 * rather than hard-coded. `projectSearchResult` scores an exact title match at
 * `tierConfidence(3)`; if that constant ever changes, this bound follows it
 * automatically instead of silently pinning a stale number.
 */
function exactMatchConfidence(): number {
  const exact: SearchResult = {
    id: "canon-exact", type: "cities", title: "Rosa", subtitle: null,
    avatarUrl: null, imageUrl: null, fallbackInitials: null, locationPreview: null,
    matchedReason: null, actionState: null, privacyState: null, accessState: null,
    destinationRoute: "/city/rosa", metadata: null, createdAt: null, startsAt: null,
  } as unknown as SearchResult;
  const projected = projectSearchResult(exact, "global_search", POLICY_V, "Rosa");
  const c = projected.confidence;
  assert.ok(typeof c === "number" && c > 0, "the exact-match band must be derivable from the projector");
  return c;
}

describe("personalization — a boosted weaker match never reaches the exact-match band (§9)", () => {
  // MUTATION-PROOF: in personalization.ts set
  //   const BOOST_CEILING = 1.0;   (from 0.985)
  // The heavily-remembered weaker row is lifted to 1.0, which is >= the exact
  // band, and this test goes RED. (Verified: the 168-test suite alone stays
  // fully GREEN under that mutation.)
  it("an enormous selection history cannot lift a substring match to a canonical exact match", () => {
    const band = exactMatchConfidence();
    // A weaker candidate sitting just below the band, with a selection history
    // large enough to saturate the boost.
    const weaker: InputSuggestion = {
      id: "s-weak", type: "entity", context: "global_search", label: "Santa Rosa",
      entityType: "city", entityId: "canon-santa-rosa",
      confidence: band - 0.01, source: "canonical", policyVersion: POLICY_V,
    };
    const memory = memoryFor("city", "canon-santa-rosa", "rosa", 500);

    const [boosted] = applyPriorSelectionBoost([weaker], memory as any, "rosa");
    assert.ok(
      (boosted.confidence ?? 0) > (weaker.confidence ?? 0),
      "the boost must actually apply — otherwise the ceiling assertion is vacuous",
    );
    assert.ok(
      (boosted.confidence ?? 0) < band,
      `a personalized weaker match (${boosted.confidence}) must stay strictly below the exact-match band (${band})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. §29/§35 — personalization surfaces PUBLIC GEO entities only
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The dangerous case is not "the id fails to resolve" — it is that
 * `projectPersonalizedGeo` hard-codes `entityType: 'city'`, so ANY remembered
 * entity type that reaches it is re-published as a city. Ids across tables are
 * uuids from independent id spaces with no disjointness guarantee, so the
 * fixture gives `canonical_locations` a row whose id collides with a remembered
 * PERSON. With SURFACEABLE_GEO_TYPES in place the person is filtered out before
 * the lookup; without it, a private person's memory entry is surfaced — mislabelled
 * as a city — outside the privacy gate.
 */
describe("personalization — only public canonical geo entities are surfaced (§29/§35)", () => {
  const COLLIDING_ID = "canon-shared-id";
  const db = () => makeFakeClient({
    canonical_locations: [canonCity("Bangkok", COLLIDING_ID, "Thailand")],
  });

  // MUTATION-PROOF: in personalization.ts add 'user' (or 'place') to
  //   const SURFACEABLE_GEO_TYPES = new Set<EntityType>(['city', 'country']);
  // Both assertions below go RED — the remembered person is injected and
  // surfaced as a city. (Verified: the 168-test suite alone stays fully GREEN
  // under that mutation.)
  it("a remembered PERSON is never injected as a learned mapping", async () => {
    const personMemory = memoryFor("user", COLLIDING_ID, "bkok", 9);
    const out = await buildLearnedGeoInjections(db() as any, {
      memory: personMemory as any,
      queryKey: "bkok",
      context: "city_picker" as InputContext,
      isGeoPicker: true,
      policyVersion: POLICY_V,
      max: 3,
      existingEntityIds: new Set<string>(),
    });
    assert.deepEqual(out, [], "a remembered person must never be injected by personalization");
  });

  it("a remembered PERSON is never served as a zero-character recent", async () => {
    const personMemory = {
      byEntity: new Map(),
      recentEntities: [{
        entityType: "user", entityId: COLLIDING_ID, total: 9,
        byQuery: new Map<string, number>(), lastSelectedAt: "2026-09-01T00:00:00.000Z", label: "Someone",
      }],
      isEmpty: false,
    };
    const out = await buildSelectionRecents(db() as any, {
      memory: personMemory as any,
      context: "city_picker" as InputContext,
      isGeoPicker: true,
      policyVersion: POLICY_V,
      max: 5,
    });
    assert.deepEqual(out, [], "a remembered person must never be served as a geo recent");
  });

  it("the same fixture DOES surface a remembered CITY — so the two assertions above are not vacuous", async () => {
    const cityMemory = memoryFor("city", COLLIDING_ID, "bkok", 9);
    const out = await buildLearnedGeoInjections(db() as any, {
      memory: cityMemory as any,
      queryKey: "bkok",
      context: "city_picker" as InputContext,
      isGeoPicker: true,
      policyVersion: POLICY_V,
      max: 3,
      existingEntityIds: new Set<string>(),
    });
    assert.equal(out.length, 1, "a remembered city on the identical fixture must be injected");
    assert.equal(out[0]!.entityType, "city");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. §47 — the gateway sanitizes the query before candidate generation
// ═══════════════════════════════════════════════════════════════════════════════

describe("gateway — PostgREST filter metacharacters are stripped from the query (§47)", () => {
  // MUTATION-PROOF: in gateway.ts replace
  //   const q = sanitizeQuery(aliased).slice(0, 80);
  // with
  //   const q = aliased.slice(0, 80);
  // The raw parenthesis/comma payload survives into the emitted completion row's
  // submit_search action and this test goes RED. (Verified: the 168-test suite
  // alone stays fully GREEN under that mutation.)
  it("the emitted query-completion row carries no ( ) or , from the typed text", async () => {
    const sc = makeFakeClient({
      profiles: [], canonical_locations: [], blocks: [], age_restricted: [],
    });
    const policy = resolvePolicy("global_search")!;
    const injection = "beach,or(id.eq.1)";
    const out = await generateSuggestions(sc, {
      context: "global_search",
      policy,
      text: injection,
      userId: ME,
      limit: policy.maxSuggestions,
      lat: null, lng: null, city: null,
    });

    const completion = out.find((s) => s.type === "completion");
    assert.ok(completion, "a completion row must be emitted — otherwise this test is vacuous");
    const action = completion!.action as { type: string; query?: string } | undefined;
    assert.equal(action?.type, "submit_search");
    const carried = `${action?.query ?? ""} ${completion!.label ?? ""} ${completion!.replacementText ?? ""}`;
    for (const ch of ["(", ")", ","]) {
      assert.ok(
        !carried.includes(ch),
        `the gateway must strip PostgREST filter metacharacter "${ch}" before it reaches candidate generation`,
      );
    }
    assert.ok(carried.includes("beach"), "the meaningful query text still survives sanitization");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. §9 — the boost never touches an AI / action row
// ═══════════════════════════════════════════════════════════════════════════════

describe("personalization — memory never boosts an AI guess or an action (§9)", () => {
  // MUTATION-PROOF: in personalization.ts add 'ai_suggestion' (and/or 'action')
  // to BOOSTABLE_TYPES. The AI row is boosted and this test goes RED.
  // (Verified: the 168-test suite alone stays fully GREEN under that mutation.)
  it("an ai_suggestion carrying a remembered entity id keeps its original confidence", () => {
    const ID = "canon-bangkok";
    const memory = memoryFor("city", ID, "bkok", 20);

    const aiRow: InputSuggestion = {
      id: "s-ai", type: "ai_suggestion", context: "compass_prompt", label: "Try Bangkok",
      entityType: "city", entityId: ID, confidence: 0.4, source: "ai", policyVersion: POLICY_V,
    };
    const entityRow: InputSuggestion = {
      id: "s-entity", type: "entity", context: "compass_prompt", label: "Bangkok",
      entityType: "city", entityId: ID, confidence: 0.4, source: "canonical", policyVersion: POLICY_V,
    };

    const [ai, entity] = applyPriorSelectionBoost([aiRow, entityRow], memory as any, "bkok");
    assert.equal(ai.confidence, 0.4, "an AI proposal must never be lifted by selection memory (§9 trust order)");
    assert.ok(
      (entity.confidence ?? 0) > 0.4,
      "the canonical entity row on the identical memory IS boosted — proves the assertion above is not vacuous",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Regression fence for the read side of §35 (owner scope, empty-table posture)
// ═══════════════════════════════════════════════════════════════════════════════

describe("personalization — selection memory read stays owner-scoped and fail-soft (§35)", () => {
  it("an absent input_selection_history degrades to an empty memory, not an error", async () => {
    // PROD POSTURE: migration 2258 is applied to CI but NOT to production, so
    // this read returns nothing there. The contract is that it degrades to the
    // cold-start path rather than throwing into the typeahead.
    const sc = makeFakeClient({});
    const mem = await fetchSelectionMemory(sc as any, { userId: ME, context: "city_picker" });
    assert.equal(mem.isEmpty, true);
    assert.equal(mem.recentEntities.length, 0);
  });

  it("another user's rows are never read into this user's memory", async () => {
    const sc = makeFakeClient({
      input_selection_history: [
        { user_id: BOB, context: "city_picker", entity_type: "city", entity_id: "canon-bangkok", query_key: "bkok", label: "Bangkok", selection_count: 50, last_selected_at: "2026-09-01T00:00:00.000Z" },
        { user_id: ME, context: "city_picker", entity_type: "city", entity_id: "canon-rosa", query_key: "rosa", label: "Rosa", selection_count: 1, last_selected_at: "2026-09-02T00:00:00.000Z" },
      ],
    });
    const mem = await fetchSelectionMemory(sc as any, { userId: ME, context: "city_picker" });
    assert.equal(mem.byEntity.size, 1, "only the owner's row is loaded");
    assert.ok(mem.byEntity.has("city:canon-rosa"));
    assert.ok(!mem.byEntity.has("city:canon-bangkok"), "another user's selection must never enter this memory");
  });
});

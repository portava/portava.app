/**
 * Telegraph §606's SIXTH capability — search behaviour, registered through the
 * same content capability contract as the other five.
 *
 * THE ROW THIS EXISTS FOR. census-discovery A20 reads:
 *
 *   Telegraph `:606` — "Every shareable Portava domain registers preview,
 *   authorization, current state, actions, search behavior, and revocation
 *   through a Telegraph content capability contract."
 *
 * Five of the six were registered in `services/telegraph/shareables.ts`, one
 * `LOADERS` entry per object family. The sixth was registered somewhere else
 * entirely — `SUBTYPE_BUCKET` / `STRUCTURED_SUBTYPES` in
 * `domain/telegraph/contracts/conversationSearch.ts`, keyed by MESSAGE SUBTYPE.
 *
 * TWO REGISTRIES KEYED DIFFERENTLY CANNOT BE CHECKED AGAINST EACH OTHER, and
 * that is the defect rather than the untidiness. `MAP_PIN` and `MEETUP_POINT`
 * are both in `LOADERS` and neither was in either search map: a Discovery pin
 * shared into a thread had a preview, an authorization refusal, a live state and
 * a revocation, and no bucket — and nothing in the tree could say so, because
 * nothing read the two registries together.
 *
 * WHAT THESE TESTS PIN, and what each would catch:
 *   A. The sixth capability is ON the contract. `shareableFor(...)` answers
 *      `getSearchBehaviour()`. Deleting the member fails to compile; returning
 *      a hard-coded bucket instead of the registration fails A3.
 *   B. Every family Discovery shares registers it. A20 names PLACE, MAP_PIN and
 *      HIDDEN_GEM; a loader added without a registration fails B2.
 *   C. The subtype maps the search path actually reads are DERIVED, not a second
 *      copy. Every assertion here is against the derived value, so a hand-edit
 *      that re-forks them fails.
 *   D. Behaviour is byte-identical to the hand-written maps this replaces —
 *      the ten subtypes, their buckets, and the eight structured ones.
 *   E. The exception is declared, not hidden. `compass_card` has a bucket and no
 *      family; that is stated in `FAMILYLESS_SUBTYPE_BUCKET` with a reason, and
 *      the test asserts it is the ONLY one, so a second silent exception fails.
 *
 * SHOWN RED before commit — every mutation applied, watched fail, reverted, and
 * the file compared byte-for-byte with its backup afterwards. See
 * docs/architecture/census-discovery.md §9.
 *
 * Run: node --import tsx/esm --test src/test/telegraphSearchCapability.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_BEHAVIOUR,
  FAMILYLESS_SUBTYPE_BUCKET,
  SUBTYPE_BUCKET,
  STRUCTURED_SUBTYPES,
  TELEGRAPH_SEARCH_BUCKETS,
  classifyMessage,
  searchBehaviourFor,
} from "../domain/telegraph/contracts/conversationSearch.js";
import {
  SHAREABLE_OBJECT_TYPES,
  shareableFor,
  searchBehaviourForObjectType,
} from "../services/telegraph/shareables.js";
import { isTelegraphObjectType } from "../services/telegraph/vocabulary.js";

const PLACE_ID = "aaaa0000-0000-4000-8000-000000000001";
/** No read happens in this file; the client is never touched. */
const NO_CLIENT = new Proxy({}, {
  get() { throw new Error("a search-behaviour question must not touch the database"); },
}) as never;

// ── A. the capability is on the contract ─────────────────────────────────────

describe("A. §606's sixth capability answers from the share contract", () => {
  it("A1 — a shareable exposes getSearchBehaviour alongside the other five", () => {
    const s = shareableFor(NO_CLIENT, "PLACE", PLACE_ID);
    assert.ok(s, "PLACE must be shareable");
    for (const member of ["getSharePreview", "getCurrentState", "getAvailableActions", "getDeepLink", "getSearchBehaviour"]) {
      assert.equal(typeof (s as unknown as Record<string, unknown>)[member], "function", `${member} must be on the contract`);
    }
  });

  it("A2 — it answers without touching the database", () => {
    const s = shareableFor(NO_CLIENT, "HIDDEN_GEM", PLACE_ID)!;
    // NO_CLIENT throws on any property read; reaching the assertion proves none happened.
    assert.deepEqual(s.getSearchBehaviour(), SEARCH_BEHAVIOUR["HIDDEN_GEM"]);
  });

  it("A3 — it answers the REGISTRATION, not a per-object guess", () => {
    for (const t of SHAREABLE_OBJECT_TYPES) {
      const viaContract = shareableFor(NO_CLIENT, t, PLACE_ID)!.getSearchBehaviour();
      assert.deepEqual(viaContract, searchBehaviourFor(t), `${t} must answer its registration`);
      assert.deepEqual(viaContract, searchBehaviourForObjectType(t), `${t} must agree with the family-level lookup`);
    }
  });

  it("A4 — a family that registers none says null rather than guessing a bucket", () => {
    // PROFILE is shareable (LOADERS has it) and carries no card subtype.
    assert.equal(shareableFor(NO_CLIENT, "PROFILE", PLACE_ID)!.getSearchBehaviour(), null);
    assert.equal(searchBehaviourFor("NOT_A_FAMILY"), null);
  });
});

// ── B. the domains that must register, do ────────────────────────────────────

describe("B. every registered family is real, and Discovery's three are registered", () => {
  it("B1 — every key in the registration is a TelegraphObjectType", () => {
    for (const key of Object.keys(SEARCH_BEHAVIOUR)) {
      assert.ok(isTelegraphObjectType(key), `${key} is not a TelegraphObjectType — the registration names a family that does not exist`);
    }
  });

  it("B2 — A20's three Discovery families each register search behaviour", () => {
    for (const family of ["PLACE", "MAP_PIN", "HIDDEN_GEM"] as const) {
      const reg = searchBehaviourFor(family);
      assert.ok(reg, `${family} is shared by Discovery and must register the sixth capability`);
      assert.equal(reg.bucket, "PLACES");
      assert.ok(TELEGRAPH_SEARCH_BUCKETS.includes(reg.bucket));
    }
  });

  it("B3 — every registered bucket is one of §21's five", () => {
    for (const [family, reg] of Object.entries(SEARCH_BEHAVIOUR)) {
      assert.ok(TELEGRAPH_SEARCH_BUCKETS.includes(reg.bucket), `${family} registers a bucket §21 does not name`);
    }
  });
});

// ── C. the search path reads the derived maps ────────────────────────────────

describe("C. the subtype maps are derived from the registration", () => {
  it("C1 — every carriedBy subtype appears in SUBTYPE_BUCKET with its family's bucket", () => {
    for (const [family, reg] of Object.entries(SEARCH_BEHAVIOUR)) {
      for (const subtype of reg.carriedBy) {
        assert.equal(SUBTYPE_BUCKET[subtype], reg.bucket, `${subtype} (${family}) must bucket as its family does`);
      }
    }
  });

  it("C2 — STRUCTURED_SUBTYPES is exactly the structured families' subtypes plus declared exceptions", () => {
    const expected = new Set<string>();
    for (const reg of Object.values(SEARCH_BEHAVIOUR)) {
      if (reg.structured) for (const s of reg.carriedBy) expected.add(s);
    }
    for (const [s, e] of Object.entries(FAMILYLESS_SUBTYPE_BUCKET)) if (e.structured) expected.add(s);
    assert.deepEqual([...STRUCTURED_SUBTYPES].sort(), [...expected].sort());
  });

  it("C3 — SUBTYPE_BUCKET holds nothing that no family and no exception claims", () => {
    const claimed = new Set<string>();
    for (const reg of Object.values(SEARCH_BEHAVIOUR)) for (const s of reg.carriedBy) claimed.add(s);
    for (const s of Object.keys(FAMILYLESS_SUBTYPE_BUCKET)) claimed.add(s);
    assert.deepEqual(Object.keys(SUBTYPE_BUCKET).sort(), [...claimed].sort());
  });

  it("C4 — the classifier the search path calls uses the derived map", () => {
    assert.equal(classifyMessage({ subtype: "discovery_card" }), "PLACES");
    assert.equal(classifyMessage({ subtype: "hidden_gem" }), "PLACES");
    assert.equal(classifyMessage({ subtype: "meeting_point" }), "PLACES");
    assert.equal(classifyMessage({ subtype: "meetup" }), "PLANS");
    assert.equal(classifyMessage({ subtype: "post_card" }), "MEMORIES");
    // Unclaimed subtypes still fall through to the safe default.
    assert.equal(classifyMessage({ subtype: "call_started" }), "MESSAGES");
    assert.equal(classifyMessage({ subtype: null, media_url: "x" }), "MEDIA");
  });
});

// ── D. behaviour is byte-identical to the maps this replaces ─────────────────

describe("D. the derived maps equal the hand-written ones they replace", () => {
  /** Copied from the pre-change source, deliberately as a literal. */
  const BEFORE_SUBTYPE_BUCKET: Record<string, string> = {
    discovery_card: "PLACES",
    hidden_gem: "PLACES",
    meeting_point: "PLACES",
    compass_card: "PLACES",
    meetup: "PLANS",
    meetup_confirmed: "PLANS",
    meetup_cancelled: "PLANS",
    event_context_card: "PLANS",
    post_card: "MEMORIES",
    memory_card: "MEMORIES",
  };
  const BEFORE_STRUCTURED = [
    "meetup", "meetup_confirmed", "meetup_cancelled", "event_context_card",
    "meeting_point", "discovery_card", "hidden_gem", "compass_card",
  ];

  it("D1 — same ten subtypes, same ten buckets", () => {
    assert.deepEqual({ ...SUBTYPE_BUCKET }, BEFORE_SUBTYPE_BUCKET);
  });

  it("D2 — same eight structured subtypes", () => {
    assert.deepEqual([...STRUCTURED_SUBTYPES].sort(), [...BEFORE_STRUCTURED].sort());
  });
});

// ── E. the exception is declared, not hidden ─────────────────────────────────

describe("E. the one searchable subtype with no family is named", () => {
  it("E1 — compass_card is the whole exception list, with a stated reason", () => {
    assert.deepEqual(Object.keys(FAMILYLESS_SUBTYPE_BUCKET), ["compass_card"]);
    assert.match(FAMILYLESS_SUBTYPE_BUCKET["compass_card"]!.why, /compass/i);
  });

  it("E2 — an exception may not also be claimed by a family", () => {
    const claimed = new Set<string>();
    for (const reg of Object.values(SEARCH_BEHAVIOUR)) for (const s of reg.carriedBy) claimed.add(s);
    for (const s of Object.keys(FAMILYLESS_SUBTYPE_BUCKET)) {
      assert.equal(claimed.has(s), false, `${s} is declared family-less AND carried by a family`);
    }
  });
});

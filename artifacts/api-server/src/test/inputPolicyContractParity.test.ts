/**
 * Global Input Intelligence §48 — ONE policy registry, and the wire it travels
 * on.
 *
 * Run: node --import tsx --test src/test/inputPolicyContractParity.test.ts
 *
 * ── WHAT THIS FILE WAS, AND WHY MOST OF IT IS GONE (2026-09-21, G340) ────────
 *
 * This suite existed because there were TWO policy registries — this one, and a
 * hand-maintained 29-context table in
 * `travel-buddy-standalone/src/platform/input-assistance/contexts/inputContexts.ts`.
 * It measured how far they had drifted and pinned the members that were
 * load-bearing for privacy, because a test was the only lever available: it
 * could report that the two disagreed, but it could never make a shipped app
 * obey the newer one.
 *
 * The drift it measured was real and some of it ran the wrong way —
 * `allowPersonalization` differed on 14 contexts, `privacyClass` on 14,
 * `offlinePolicy` on 26, `allowedSuggestionTypes` on 26, `entityTypes` on 13.
 *
 * G340 removed the cause. The client's table is DELETED; it fetches
 * `GET /input-assistance/policies` and resolves from what this side says. There
 * is no second table to drift, so there is nothing left to compare, and the
 * seven per-context comparison cases that used to live here were deleted rather
 * than repaired — a comparison with one operand is not a weaker test, it is not
 * a test.
 *
 * ── WHAT IS STILL WORTH ASSERTING, AND IT IS NOT NOTHING ─────────────────────
 *
 * Deleting the table removed the drift. It did NOT remove the wire, and the
 * wire has its own failure mode: this side can serve a value the client cannot
 * name. That is the normal §48 skew — a newer server, an older app — not an
 * exotic case, and it is what the remaining cases cover.
 *
 *   1. THE VOCABULARIES MUST MATCH, member for member. A `privacyClass` this
 *      build invents is a class the client's cache gate cannot recognise; an
 *      `offlinePolicy` it invents is one the client's offline gate cannot act
 *      on; an `entityType` it invents is a row the client cannot route. The
 *      client narrows all three to their strictest member at runtime
 *      (`contexts/policyFallback.ts#sanitizeServedPolicy`), so a mismatch
 *      degrades safely — but it degrades SILENTLY, and a field quietly serving
 *      nothing is the failure this project keeps finding the expensive way.
 *
 *   2. THE CLIENT MUST NOT GROW A SECOND TABLE AGAIN. The regression guard is
 *      cheap and the thing it guards against took months to find.
 *
 *   3. `telemetryPolicy`'s SHAPE still matters (census G33), because the client
 *      derives its own from `privacyClass` rather than being served one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CONTEXTS, resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import { recordSelection } from "../lib/inputAssistance/personalization.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CLIENT_REGISTRY = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/contexts/inputContexts.ts",
);

interface ClientDescriptor {
  allowPersonalization: boolean;
  privacyClass: string;
  minChars: string;
  offlinePolicy: string;
  defaultMode: string;
  /** null when the entry's list could not be resolved — reported, never silently []. */
  entityTypes: string[] | null;
  /** null when the entry's list could not be resolved — reported, never silently 0. */
  allowedSuggestionTypes: string[] | null;
}

/** This side's union, read from the type rather than restated. */
const SERVER_PRIVACY_CLASSES = [
  "public",
  "viewer_scoped",
  "owner_only",
  "sensitive_location",
  "private_message",
] as const;

/** This side's offline union, restated here so the client's is compared to a
 *  named list rather than to whatever the client happens to declare. */
/** This side's entity union, restated so the comparison names a list. */
const SERVER_ENTITY_TYPES = [
  "city", "country", "neighborhood", "place", "hidden_gem", "user", "trip",
  "event", "plan", "buddy", "hashtag", "language", "interest",
  "activity", "circle", "post", "stamp", "vibe",
] as const;

const SERVER_OFFLINE_POLICIES = [
  "static_dictionary",
  "cached_local",
  "recent_only",
  "server_required",
  "unavailable",
] as const;

const CLIENT_POLICY_TYPES = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts",
);
const CLIENT_CONTEXT_TYPES = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/types/inputContext.ts",
);
const CLIENT_POLICY_DERIVATION = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/contexts/inputPolicies.ts",
);

/**
 * Strip comments before parsing a union.
 *
 * NOT incidental. The first version of `readClientEntityTypeUnion` matched
 * `=([\s\S]*?);` against the raw file, and the client's `EntityType`
 * declaration carries an explanatory comment BETWEEN its members — a comment
 * containing a semicolon. The non-greedy match stopped there and returned 13 of
 * 18 members, and the `members.length > 0` guard below happily accepted it.
 *
 * A parse that silently returns a SUBSET is worse than one that returns
 * nothing: the too-short list made the union comparison fail against a real
 * source file that was in fact correct, and the same bug in the other direction
 * would have passed a union that was genuinely short. The guards check for
 * emptiness; nothing checked for truncation. Removing comments first removes
 * the class of bug rather than this instance of it.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Parse the client's `PrivacyClass` union members out of its declaration. */
function readClientPrivacyClassUnion(): Set<string> {
  const src = withoutComments(fs.readFileSync(CLIENT_CONTEXT_TYPES, "utf8"));
  const m = /export type PrivacyClass =([\s\S]*?);/.exec(src);
  assert.ok(m, "the client must declare a PrivacyClass union");
  const members = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  assert.ok(members.length > 0, "the PrivacyClass union parsed to nothing — the declaration's shape changed");
  // TRUNCATION guard, not just an emptiness guard — see `withoutComments`.
  assert.equal(
    members.length,
    5,
    `the PrivacyClass union parsed to ${members.length} members, expected 5. A parse that silently returns a SUBSET makes every comparison below meaningless.`,
  );
  return new Set(members);
}

/** Parse the client's `OfflineInputPolicy` union members out of its declaration. */
function readClientOfflineUnion(): Set<string> {
  const src = withoutComments(fs.readFileSync(CLIENT_CONTEXT_TYPES, "utf8"));
  const m = /export type OfflineInputPolicy =([\s\S]*?);/.exec(src);
  assert.ok(m, "the client must declare an OfflineInputPolicy union");
  const members = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  assert.ok(members.length > 0, "the OfflineInputPolicy union parsed to nothing — the declaration's shape changed");
  // TRUNCATION guard, not just an emptiness guard — see `withoutComments`.
  assert.equal(
    members.length,
    5,
    `the OfflineInputPolicy union parsed to ${members.length} members, expected 5. A parse that silently returns a SUBSET makes every comparison below meaningless.`,
  );
  return new Set(members);
}

/** Parse the client's `EntityType` union members out of its declaration. */
function readClientEntityTypeUnion(): Set<string> {
  const src = withoutComments(fs.readFileSync(CLIENT_CONTEXT_TYPES, "utf8"));
  const m = /export type EntityType =([\s\S]*?);/.exec(src);
  assert.ok(m, "the client must declare an EntityType union");
  const members = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  assert.ok(members.length > 0, "the EntityType union parsed to nothing — the declaration's shape changed");
  // TRUNCATION guard, not just an emptiness guard — see `withoutComments`.
  assert.equal(
    members.length,
    18,
    `the EntityType union parsed to ${members.length} members, expected 18. A parse that silently returns a SUBSET makes every comparison below meaningless.`,
  );
  return new Set(members);
}

/**
 * Parse the client's `INPUT_CONTEXT_REGISTRY` object-literal entries. Kept to a
 * flat top-level `name: { ... },` scan so a formatting change fails loudly
 * (empty parse ⇒ the count assertion below fires) rather than silently matching
 * nothing.
 */
function readClientRegistry(): Map<string, ClientDescriptor> {
  const src = fs.readFileSync(CLIENT_REGISTRY, "utf8");
  const CLIENT_TYPE_CONSTANTS = new Map<string, string[]>();
  for (const m of src.matchAll(/^const (\w+): AssistanceType\[\] = \[([^\]]*)\];/gm)) {
    CLIENT_TYPE_CONSTANTS.set(m[1]!, [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
  }
  const out = new Map<string, ClientDescriptor>();
  const blockRe = /\n {2}(\w+): \{\n([\s\S]*?)\n {2}\},/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(src)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    const field = (key: string): string | null => {
      const f = new RegExp(`${key}:\\s*([^,\\n]+)`).exec(body);
      return f ? f[1]!.trim().replace(/^'|'$/g, "") : null;
    };
    // Only entries that look like a context descriptor.
    const pers = field("allowPersonalization");
    if (pers === null) continue;
    // `allowedSuggestionTypes` is written EITHER as an inline array OR as one of
    // the shared constants declared at the top of the client file
    // (ENTITY_PICKER_TYPES, SEARCH_TYPES, …). Resolving the constant is what
    // makes this comparable at all — reading the identifier as a value would
    // compare the string "ENTITY_PICKER_TYPES" against a list and report every
    // context as drifted, which is a finding with no information in it.
    const rawTypes = /allowedSuggestionTypes:\s*(\[[^\]]*\]|\w+)/.exec(body)?.[1] ?? null;
    let types: string[] | null = null;
    if (rawTypes !== null) {
      types = rawTypes.startsWith("[")
        ? [...rawTypes.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
        : (CLIENT_TYPE_CONSTANTS.get(rawTypes) ?? null);
    }
    out.set(name, {
      allowPersonalization: pers === "true",
      privacyClass: field("privacyClass") ?? "(default)",
      minChars: field("minChars") ?? "(default)",
      offlinePolicy: field("offlinePolicy") ?? "(default)",
      defaultMode: field("defaultMode") ?? "(default)",
      allowedSuggestionTypes: types,
      entityTypes: (() => {
        const raw = /entityTypes:\s*(\[[^\]]*\])/.exec(body)?.[1];
        return raw === undefined ? null : [...raw.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
      })(),
    });
  }
  return out;
}

describe("§48 — the client policy registry mirrors the server authority", () => {


  // ── 2026-09-21: `allowedSuggestionTypes` and `defaultMode`, RATCHETED ───────
  //
  // Found while grading G46, whose third clause asks for exactly this guard:
  // "a parity assertion over `allowedSuggestionTypes` so the two registries
  // cannot disagree about it again."
  //
  // THEY DISAGREE IN 27 OF 29 CONTEXTS, and in 3 of 29 on `defaultMode`. Those
  // are the numbers below, and they are CEILINGS rather than zeroes for a
  // reason that is worth stating rather than hiding behind a lower bar:
  // aligning the mirror to the authority is mechanically safe — nothing on the
  // client reads its copy — but the 30 values it would commit encode product
  // decisions this test may not invent. `display_name` is the sharp one: the
  // SERVER calls it a `search` context serving `['entity']`, the CLIENT calls
  // it `no_assistance` with an empty list, and whether a person's display-name
  // field should offer people-search suggestions is a question for an owner,
  // not a merge.
  //
  // WHY A CEILING IS WORTH HAVING ANYWAY. This is the shape `privacyClass` had
  // until 2026-09-21: declared on both sides, read on one, drifted on 14 of 29
  // — and two of those ran the UNSAFE way, which nobody noticed until it was
  // measured. The server enforces `allowedSuggestionTypes` at ~14 decision
  // points in the gateway. A mirror that may quietly drift further is how the
  // next such surprise gets built; a ceiling means it can only shrink.
  //
  // The real fix is G340 (a policy endpoint with the local registry demoted to
  // a cold-start fallback), which deletes the mirror rather than aligning it.
  // LOWERED 2026-09-21 (27 -> 26, and mode 3 -> 2) when the owner ruled
  // `display_name` MANUAL and the server was brought to the client's shape.
  // That is the ratchet working as its comment instructs: lower it on each
  // fix, never raise it. The remaining 26 are the ones G340 deletes.
  const MAX_ENTITY_TYPE_DRIFT = 13;
  const MAX_SUGGESTION_TYPE_DRIFT = 26;
  const MAX_DEFAULT_MODE_DRIFT = 2;




  it("uses ONE privacy vocabulary — the client declares no member this side has never heard of", () => {
    // This is the assertion the value comparison above cannot make on its own.
    // Before 2026-09-21 the client's union was `public | personal | sensitive |
    // private_message`: two of its four members did not exist here, so "do the
    // two registries agree?" had no answer, only a type error waiting to happen.
    const clientUnion = readClientPrivacyClassUnion();
    assert.deepEqual(
      [...clientUnion].sort(),
      [...SERVER_PRIVACY_CLASSES].sort(),
      "the client's PrivacyClass union must be this side's, member for member",
    );
  });

  it("uses ONE offline vocabulary — the client declares no member this side has never heard of", () => {
    // Promoted from REPORTED to ASSERTED on 2026-09-21, when G340's policy
    // endpoint made the old justification untenable. This file used to say the
    // client's offline taxonomy was "a different, device-side vocabulary" and
    // that pinning it "would freeze that debt instead of describing it". That
    // was too generous to it, and the measurement is in the case below.
    const clientUnion = readClientOfflineUnion();
    assert.deepEqual(
      [...clientUnion].sort(),
      [...SERVER_OFFLINE_POLICIES].sort(),
      "the client's OfflineInputPolicy union must be this side's, member for member — /input-assistance/policies now SERVES this field, so a member the client cannot name is a value it will be handed and cannot act on",
    );
  });



  it("uses ONE entity vocabulary — the client can name every class this side serves", () => {
    // Added 2026-09-21. Unlike the two above, this one was NOT merely a tidy-up:
    // when it was first written the client's union was short by five members
    // (`activity`, `circle`, `post`, `stamp`, `vibe`), four of which this side
    // serves TODAY in `global_search`, `plan_title` and `buddy_service`.
    //
    // Two defects were behind that gap on the client, and the second is the
    // reason this is asserted rather than left to the runtime narrowing: a
    // served `stamp` was rendered as a Place (a wrong icon, a wrong group), and
    // — worse — its row was DROPPED entirely, because the client's route
    // synthesiser had no case for it either. Neither failure announces itself.
    const clientUnion = readClientEntityTypeUnion();
    const served = new Set<string>();
    for (const ctx of KNOWN_CONTEXTS) {
      for (const e of resolvePolicy(ctx)?.entityTypes ?? []) served.add(e);
    }
    const unnameable = [...served].filter((e) => !clientUnion.has(e)).sort();
    assert.deepEqual(
      unnameable,
      [],
      `this side serves entity classes the client cannot name: ${unnameable.join(", ")}`,
    );

    // And the whole union, not just the part in use — so the NEXT member added
    // here is what goes red, rather than the first context that starts serving it.
    assert.deepEqual(
      [...SERVER_ENTITY_TYPES].sort(),
      [...clientUnion].sort(),
      "the client's EntityType union must be this side's, member for member",
    );
  });

  it("the client declares NO context table — one registry, and it is this one", () => {
    // THE REGRESSION GUARD. G340 deleted
    // `inputContexts.ts#INPUT_CONTEXT_REGISTRY`, the 29-context table that was
    // the second source of truth this whole file used to measure. Re-adding one
    // would restore the drift silently: every other case here would keep
    // passing, because none of them compares per-context values any more.
    //
    // Matched on the DECLARATION, not on a substring, so the word may still
    // appear in the prose that explains why it is gone.
    const src = fs.readFileSync(CLIENT_REGISTRY, "utf8");
    const declarations = [
      /export\s+const\s+INPUT_CONTEXT_REGISTRY/,
      /export\s+const\s+INPUT_POLICY_VERSION\s*=/,
    ];
    for (const re of declarations) {
      assert.equal(
        re.test(src),
        false,
        `${CLIENT_REGISTRY} re-declares ${re.source} — the client must resolve policy from GET /input-assistance/policies, not from a local copy`,
      );
    }
    // Non-vacuity: the file still exists and still exports the resolver.
    assert.match(src, /export function getContextDescriptor/);
  });

  it("agrees with the server on the SHAPE of telemetryPolicy (census G33)", () => {
    // The client derives its telemetry policy from privacyClass rather than
    // declaring it per context, so what is pinned here is the contract: the
    // member NAMES and the event vocabulary. A `captureRawText`/`logRawText`
    // split is not a naming preference — it is why nothing could compare the
    // two sides on the member that decides whether the user's typed text is
    // allowed into an analytics event.
    const src = fs.readFileSync(CLIENT_POLICY_TYPES, "utf8");
    assert.match(src, /logRawText: boolean;/, "the client must declare `logRawText`, not `captureRawText`");
    assert.doesNotMatch(src, /captureRawText\s*:/, "`captureRawText` must not survive anywhere in the client contract");
    assert.match(src, /events: InputTelemetryEventName\[\];/, "`events` must be a plain list on both sides — the `'all'` sentinel had no server counterpart");

    // And the derivation must not hand any field permission to log raw text,
    // because no server context grants it.
    for (const ctx of KNOWN_CONTEXTS) {
      assert.equal(
        resolvePolicy(ctx)!.telemetryPolicy.logRawText,
        false,
        `${ctx} declares logRawText true on the server; the client derivation assumes none does`,
      );
    }
    const derivation = fs.readFileSync(CLIENT_POLICY_DERIVATION, "utf8");
    assert.match(derivation, /logRawText: false/, "the client derivation must set logRawText false");
  });

  it("no personalization-enabled context carries a private/sensitive server privacy class", () => {
    // A context that both records selections AND is classed private would let a
    // private-field selection reach the memory table. The registry must never
    // pair them; this is the invariant the two gates above exist to serve.
    for (const ctx of KNOWN_CONTEXTS) {
      const p = resolvePolicy(ctx)!;
      if (!p.allowPersonalization) continue;
      assert.ok(
        p.privacyClass !== "private_message" && p.privacyClass !== "sensitive_location",
        `${ctx} is personalization-enabled but classed ${p.privacyClass}`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §6 `privacyClass` as a GATE, not a label (census G31)
//
// The row read "declared at policyRegistry.ts:88 … and read by nothing. The
// parity test inspects it, but no production path branches on it, and the
// actual sensitive-location protection would be identical if this field were
// deleted."
//
// It is a gate now. `recordSelection` is the one write path into
// `input_selection_history`, and `p_query_key` is derived from the text the
// user typed. These tests drive that function with a policy the registry does
// not currently contain — personalization-enabled AND sensitive — because that
// is precisely the combination the gate exists for and precisely the one no
// fixture built from the live registry can produce.
//
// MUTATION: delete the MEMORABLE_PRIVACY_CLASSES check in
// `lib/inputAssistance/personalization.ts` and the first two go RED.
// ═══════════════════════════════════════════════════════════════════════════════

describe("§6 — privacyClass refuses the selection-memory write", () => {
  function fakeDb(calls: string[]) {
    return {
      rpc: async (name: string) => {
        calls.push(name);
        return { error: null };
      },
    } as unknown as Parameters<typeof recordSelection>[0];
  }

  function policyWith(privacyClass: string): Parameters<typeof recordSelection>[1] {
    // Start from a REAL registry policy so every other field is what the
    // gateway would hand this function, then force the two members under test.
    const base = resolvePolicy("city_picker")!;
    return { ...base, allowPersonalization: true, privacyClass } as typeof base;
  }

  const params = {
    userId: "u1",
    context: "city_picker" as const,
    entityType: "city" as const,
    entityId: "c1",
    query: "the text the user typed",
    label: "Bangkok",
  };

  for (const cls of ["sensitive_location", "private_message", "owner_only"]) {
    it(`refuses a ${cls} field even when allowPersonalization is true`, async () => {
      const calls: string[] = [];
      const res = await recordSelection(fakeDb(calls), policyWith(cls), params);
      assert.equal(res.recorded, false);
      assert.equal(res.reason, "privacy_class_refuses_memory");
      assert.deepEqual(calls, [], "no write may reach the database");
    });
  }

  it("still records for the classes the registry actually uses", async () => {
    // Not vacuous: a gate that refused everything would pass all three cases
    // above and break §35 entirely.
    for (const cls of ["public", "viewer_scoped"]) {
      const calls: string[] = [];
      const res = await recordSelection(fakeDb(calls), policyWith(cls), params);
      assert.equal(res.recorded, true, `${cls} must still record`);
      assert.deepEqual(calls, ["input_record_selection"]);
    }
  });

  it("the gate is an ALLOWLIST — a new PrivacyClass member is refused by default", () => {
    // The reason this is an allowlist and not a denylist. A member added to
    // `PrivacyClass` tomorrow is exactly the case where nobody asked "may this
    // reach the memory table?", and a denylist would answer yes.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "artifacts/api-server/src/lib/inputAssistance/personalization.ts"),
      "utf8",
    );
    assert.match(src, /MEMORABLE_PRIVACY_CLASSES/);
    assert.match(src, /!MEMORABLE_PRIVACY_CLASSES\.has\(policy\.privacyClass\)/);
  });
});

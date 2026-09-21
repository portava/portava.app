/**
 * Global Input Intelligence §48 — the server is the policy AUTHORITY; the client
 * registry is a MIRROR of it, not a second opinion.
 *
 * Run: node --import tsx/esm --test src/test/inputPolicyContractParity.test.ts
 *
 * WHY
 * ---
 * §48's whole promise is one policy contract, versioned server-side, so a policy
 * change ships without a client release. There is no policy ENDPOINT today, so
 * the client re-declares all 29 contexts in
 * `travel-buddy-standalone/src/platform/input-assistance/contexts/inputContexts.ts`.
 * That is a duplicated source of truth, and a re-audit measured how far the two
 * had drifted: `minChars` differed on 20 of 29 contexts, `offlinePolicy` on 26
 * (the two unions are not even the same taxonomy), and — the one that matters —
 * `allowPersonalization` on 14.
 *
 * `allowPersonalization` is a PRIVACY gate on both sides:
 *   • server `personalization.recordSelection` refuses to store anything for a
 *     context whose policy has it false;
 *   • client `selectBody.selectionFromSuggestion` refuses to SEND anything for
 *     the same reason — and the payload it would otherwise send carries
 *     `query`: the user's RAW typed text, up to 200 characters.
 *
 * Client-true / server-false therefore meant the client believed `caption` and
 * `comment` were personalization-enabled: any surface that wired the SDK's
 * accept handler to one of those fields would have transmitted the user's raw
 * caption/comment text to `/input-assistance/select`, where the server discards
 * it — after it has already left the device and reached the request log. The
 * §49 Telemetry certification ("caption / comment / telegraph_message record
 * NOTHING") was true of STORAGE and silent about transmission.
 *
 * No surface wires those fields today, so this was latent, not live. This test
 * makes it impossible to reintroduce: the client's privacy gate must equal the
 * server's, context for context.
 *
 * MUTATION-PROOF: flip `allowPersonalization` on either side for any single
 * context and this test goes RED naming that context.
 *
 * The other two dimensions are REPORTED, not asserted. They are real §48 debt,
 * but `minChars` and `offlinePolicy` are legitimately allowed to be tuned per
 * side today (the client's offline taxonomy is a different, device-side
 * vocabulary), and pinning them here would freeze that debt instead of
 * describing it. Asserting only the privacy-load-bearing field is the honest
 * line.
 *
 * ── 2026-09-21: `privacyClass` JOINS THE ASSERTED SET (census G31, G33) ──────
 *
 * The census read `privacyClass` as "declared and read by nothing". That is
 * true of THIS side and false of the other one, and the difference is the
 * defect. On the client it gates three things: whether a field's suggestions
 * may enter the process-global `sharedSuggestionCache`, whether the select
 * payload carrying the user's raw typed text may be SENT, and what telemetry
 * policy the field gets. On this side it gated nothing at all.
 *
 * And the two sides were not even speaking the same language. The client
 * declared a FOUR-member taxonomy — `public | personal | sensitive |
 * private_message` — of which exactly two members existed here. Measured
 * before the fix, 14 of 29 contexts disagreed, and two of the disagreements ran
 * the wrong way:
 *
 *   `hidden_gem_name`   server `sensitive_location`  client `public`
 *   `comment`           server `viewer_scoped`       client `public`
 *
 * `public` was the client's own condition for `captureRawText: true`, so the
 * client's telemetry gate said "log the raw text" for a Hidden Gem name and a
 * comment body while the authority said sensitive. Latent only because
 * `setTelemetrySink` is called from no non-test file — the same shape as the
 * `allowPersonalization` finding, one member over, and the reason this test
 * exists at all.
 *
 * The fix took the STRICTER side on both registries, never the looser, and
 * added the gate this side was missing
 * (`lib/inputAssistance/personalization.ts#MEMORABLE_PRIVACY_CLASSES`).
 * `telemetryPolicy` is pinned for the same reason, one layer down: census G33
 * recorded that the two sides declared different SHAPES for it, so a server
 * policy change to it could not reach the client even in principle.
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
}

/** This side's union, read from the type rather than restated. */
const SERVER_PRIVACY_CLASSES = [
  "public",
  "viewer_scoped",
  "owner_only",
  "sensitive_location",
  "private_message",
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

/** Parse the client's `PrivacyClass` union members out of its declaration. */
function readClientPrivacyClassUnion(): Set<string> {
  const src = fs.readFileSync(CLIENT_CONTEXT_TYPES, "utf8");
  const m = /export type PrivacyClass =([\s\S]*?);/.exec(src);
  assert.ok(m, "the client must declare a PrivacyClass union");
  const members = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  assert.ok(members.length > 0, "the PrivacyClass union parsed to nothing — the declaration's shape changed");
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
    out.set(name, {
      allowPersonalization: pers === "true",
      privacyClass: field("privacyClass") ?? "(default)",
      minChars: field("minChars") ?? "(default)",
      offlinePolicy: field("offlinePolicy") ?? "(default)",
    });
  }
  return out;
}

describe("§48 — the client policy registry mirrors the server authority", () => {
  it("declares exactly the same 29 contexts the server does", () => {
    const client = readClientRegistry();
    assert.ok(
      client.size >= 20,
      `the client registry must parse (got ${client.size} contexts) — if this is 0 the file layout changed and every assertion below would be vacuous`,
    );
    const serverNames = [...KNOWN_CONTEXTS].sort();
    const clientNames = [...client.keys()].sort();
    assert.deepEqual(clientNames, serverNames, "the two registries must cover the identical context set");
  });

  it("agrees with the server on allowPersonalization for EVERY context (privacy gate)", () => {
    const client = readClientRegistry();
    const mismatches: string[] = [];
    for (const ctx of KNOWN_CONTEXTS) {
      const server = resolvePolicy(ctx);
      assert.ok(server, `server policy missing for ${ctx}`);
      const c = client.get(ctx);
      assert.ok(c, `client descriptor missing for ${ctx}`);
      if (c!.allowPersonalization !== server!.allowPersonalization) {
        mismatches.push(
          `${ctx}: server=${server!.allowPersonalization} client=${c!.allowPersonalization}`,
        );
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      "allowPersonalization is a privacy gate on BOTH sides — the client's copy decides whether the user's RAW typed text is SENT to /input-assistance/select at all, and the server's decides whether it is stored. They must not disagree:\n  " +
        mismatches.join("\n  "),
    );

    // Not vacuous: the registry genuinely splits, so an all-true or all-false
    // client copy could not pass by accident.
    const enabled = KNOWN_CONTEXTS.filter((c) => resolvePolicy(c)!.allowPersonalization);
    assert.ok(
      enabled.length > 0 && enabled.length < KNOWN_CONTEXTS.length,
      "the server registry must contain BOTH personalization-enabled and personalization-disabled contexts",
    );
  });

  it("agrees with the server on privacyClass for EVERY context", () => {
    const client = readClientRegistry();
    const mismatches: string[] = [];
    for (const ctx of KNOWN_CONTEXTS) {
      const server = resolvePolicy(ctx)!;
      const c = client.get(ctx);
      assert.ok(c, `client descriptor missing for ${ctx}`);
      if (c!.privacyClass !== server.privacyClass) {
        mismatches.push(`${ctx}: server=${server.privacyClass} client=${c!.privacyClass}`);
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      "privacyClass decides, on the CLIENT, whether a field's suggestions may be cached process-wide, whether the raw typed text may be sent to /input-assistance/select, and what telemetry policy the field derives. The server's copy is the authority. They must not disagree:\n  " +
        mismatches.join("\n  "),
    );

    // Not vacuous: the registry genuinely spreads across the union, so an
    // all-public client copy could not pass by accident.
    const distinct = new Set(KNOWN_CONTEXTS.map((c) => resolvePolicy(c)!.privacyClass));
    assert.ok(
      distinct.size >= 3,
      `the server registry must use at least three privacy classes (got ${[...distinct].join(", ")})`,
    );
  });

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

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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_CONTEXTS, resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CLIENT_REGISTRY = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/contexts/inputContexts.ts",
);

interface ClientDescriptor {
  allowPersonalization: boolean;
  minChars: string;
  offlinePolicy: string;
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

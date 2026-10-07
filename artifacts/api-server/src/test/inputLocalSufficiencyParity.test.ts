/**
 * Lead ruling PR-D2-5 (2026-10-07), census G224 / G212 — the CONDITIONS the
 * ruling attached, as a test that fails the moment either stops holding.
 *
 * The ruling: `language` and `interest` may answer from the SHIPPED list with no
 * request ONLY while the shipped list is byte-for-byte what the server returns
 * for every viewer. So this file fails if
 *   1. the shipped list and the server's list diverge (labels or order);
 *   2. for ANY query in the sweep, the client's no-request answer differs from
 *      what the REAL gateway serves for the same text — row for row, every field
 *      but the two that state provenance (`source: 'local'`, and the
 *      `policyVersion` of the table the device holds);
 *   3. the server's answer for these contexts varies by viewer — different
 *      accounts, block lists, positions, cities, time zones and Trip context;
 *   4. the authority sanctions any other context, or stops sanctioning these;
 *   5. the client's copy of the words the server rewrites before searching
 *      (`data/serverRewrittenTokens.ts`) differs from the server's alias keys, or
 *      the server's other rewrite (native-script city names) gains an ASCII key
 *      the client would not know to refuse.
 *
 * The client function is imported across the package boundary on purpose (as
 * inputAssistanceRankingSignals.test.ts imports the client's badge words): a
 * copy here would be a second answerer agreeing with itself.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - data/languages.ts: swap two labels → "the shipped list IS the server's" red.
 *   - searchCandidates.ts COMMON_INTERESTS: add one label → same case red.
 *   - localDictionary.ts: drop the slice-before-rank (rank all hits, then cap) →
 *     SURVIVES, measured: on today's two lists no swept query has a higher-tier
 *     hit beyond its first eight, so the two orders coincide. The line mirrors
 *     searchStatic so the answers stay equal if the lists grow; the list-parity
 *     case goes red first whenever they change.
 *   - searchCandidates.ts: make the languages answer depend on the viewer (drop
 *     the first label for one account) → "does not vary by viewer" red.
 *   - localDictionary.ts: answer 1-character queries → the sweep red (the gateway
 *     dispatches entities only at ≥ 2 characters).
 *   - localDictionary.ts: confidence 0.86 for a prefix → the sweep red.
 *   - localDictionary.ts: drop the rewritten-token refusal → the sweep red
 *     (query "nightlif": the server searches "nightlife" and scores it exact).
 *   - data/serverRewrittenTokens.ts: drop 'gl' → the token-list case red AND the
 *     sweep red (query "gl").
 *   - gateway.ts: a viewer-scoped term reaching these rows (simulated by the
 *     personalization flag on the language seed) → the policy case red, since
 *     the sanction refuses a personalised context.
 *
 * Run: node --import tsx/esm --test src/test/inputLocalSufficiencyParity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy, KNOWN_CONTEXTS, sanctionLocalSufficiency } from "../lib/inputAssistance/policyRegistry.js";
import { dispatchSearch } from "../lib/inputAssistance/searchCandidates.js";
import type { InputContext, InputSuggestion } from "../lib/inputAssistance/types.js";
import {
  sufficientLocalRows,
  localAnswerSuffices,
  LOCALLY_SUFFICIENT_CONTEXTS as CLIENT_CONTEXTS,
} from "../../../../travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts";
import { LANGUAGE_DICTIONARY } from "../../../../travel-buddy-standalone/src/platform/input-assistance/data/languages.ts";
import { INTEREST_DICTIONARY } from "../../../../travel-buddy-standalone/src/platform/input-assistance/data/interests.ts";
import { SERVER_REWRITTEN_TOKENS } from "../../../../travel-buddy-standalone/src/platform/input-assistance/data/serverRewrittenTokens.ts";
import { SEARCH_ALIASES } from "../lib/inputAssistance/searchQueryHelpers.js";
import { NATIVE_CITY_NAMES } from "../lib/inputAssistance/queryNormalizer.js";

const VIEWER_A = "aa000000-0000-4000-a000-00000000000a";
const VIEWER_B = "bb000000-0000-4000-a000-00000000000b";

/** A permissive fake: every table answers, with the rows the case supplies. */
function fakeClient(state: Record<string, any[]> = {}) {
  return {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const rows = [...(state[table] ?? [])];
      const b: any = {
        select: () => b, eq: () => b, neq: () => b, in: () => b, not: () => b, is: () => b, ilike: () => b,
        or: () => b, gte: () => b, lt: () => b, lte: () => b, gt: () => b, order: () => b, limit: () => b, range: () => b,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (f: any, r: any) => Promise.resolve({ data: rows, error: null }).then(f, r),
      };
      return b;
    },
  };
}

type ServeOpts = { userId?: string; lat?: number | null; lng?: number | null; city?: string | null; tz?: string | null; state?: Record<string, any[]>; sessionContext?: any };

async function serve(context: InputContext, text: string, o: ServeOpts = {}): Promise<InputSuggestion[]> {
  const policy = resolvePolicy(context)!;
  return generateSuggestions(fakeClient(o.state) as any, {
    context,
    policy,
    text,
    userId: o.userId ?? VIEWER_A,
    limit: policy.maxSuggestions,
    lat: o.lat ?? null,
    lng: o.lng ?? null,
    city: o.city ?? null,
    tz: o.tz ?? null,
    sessionContext: o.sessionContext,
  });
}

function clientAnswer(context: InputContext, text: string): InputSuggestion[] {
  const p = resolvePolicy(context)!;
  return sufficientLocalRows(
    {
      context: p.context as any,
      offlinePolicy: p.offlinePolicy as any,
      privacyClass: p.privacyClass as any,
      entityTypes: p.entityTypes as any,
      allowedSuggestionTypes: p.allowedSuggestionTypes as any,
      maxSuggestions: p.maxSuggestions,
    },
    { ...(p as any), authoritative: true },
    text,
  ) as unknown as InputSuggestion[];
}

/** Every field but the two that state provenance. */
function comparable(rows: InputSuggestion[]): unknown[] {
  return rows.map((r) => {
    const { source: _s, policyVersion: _v, ...rest } = r as any;
    return JSON.parse(JSON.stringify(rest));
  });
}

function sweep(labels: readonly string[]): string[] {
  const out = new Set<string>();
  const az = "abcdefghijklmnopqrstuvwxyz";
  for (const a of az) for (const b of az) out.add(a + b);
  for (const l of labels) {
    for (let n = 2; n <= l.length; n++) {
      out.add(l.slice(0, n));
      out.add(l.slice(0, n).toLowerCase());
      out.add(l.slice(0, n).toUpperCase());
    }
    for (let i = 1; i + 2 <= l.length; i++) out.add(l.slice(i, i + 3).toLowerCase());
  }
  for (const odd of ["a", "e", " sp", "sp ", "spa nish", "español", "thai!", "12", "", "  "]) out.add(odd);
  return [...out];
}

describe("PR-D2-5 — the shipped list IS the server's, for every viewer", () => {
  for (const [context, type, shipped] of [
    ["language", "languages", LANGUAGE_DICTIONARY],
    ["interest", "interests", INTEREST_DICTIONARY],
  ] as const) {
    it(`${context}: the shipped list IS the server's list, label for label and in order`, async () => {
      const server = await dispatchSearch(fakeClient() as any, "", VIEWER_A, new Set(), new Set(), type, 0, 1000);
      assert.deepEqual(shipped.map((e) => e.label), server.map((r) => r.title));
    });

    it(`${context}: for every query swept, the no-request answer is the gateway's, row for row`, async () => {
      let answered = 0;
      for (const q of sweep(shipped.map((e) => e.label))) {
        const local = clientAnswer(context, q);
        if (local.length === 0) continue; // the client asks the server instead — always safe
        answered++;
        const served = await serve(context, q);
        assert.deepEqual(comparable(local), comparable(served), `query ${JSON.stringify(q)}`);
        assert.ok(local.every((r) => r.source === "local"), "provenance stays honest");
      }
      assert.ok(answered >= 100, `the sweep must exercise the local path, not pass vacuously (answered ${answered})`);
    });

    it(`${context}: the server's answer does not vary by viewer`, async () => {
      // Every item is reached: each label's own first two letters match it.
      const queries = [...new Set([...shipped.map((e) => e.label.slice(0, 2).toLowerCase()), "an", "in", "er", "sh"])];
      for (const q of queries) {
        const base = await serve(context, q);
        const variants = await Promise.all([
          serve(context, q, { userId: VIEWER_B }),
          serve(context, q, { state: { blocks: [{ blocker_id: VIEWER_A, blocked_id: VIEWER_B }] } }),
          serve(context, q, { lat: 16.05, lng: 108.2, city: "Da Nang" }),
          serve(context, q, { tz: "Asia/Bangkok" }),
          serve(context, q, { sessionContext: { tripDestination: { cityId: "c1", city: "Bangkok", country: "Thailand" } } }),
        ]);
        for (const v of variants) assert.deepEqual(comparable(v), comparable(base), `query ${q}`);
      }
    });
  }

  it("the client refuses exactly the words the server rewrites", () => {
    assert.deepEqual([...SERVER_REWRITTEN_TOKENS].sort(), Object.keys(SEARCH_ALIASES).map((k) => k.toLowerCase()).sort());
    const asciiNative = Object.keys(NATIVE_CITY_NAMES).filter((k) => /^[A-Za-z ]+$/.test(k));
    assert.deepEqual(asciiNative, [], "an ASCII native-name key would rewrite a query the client answers locally");
  });

  it("the authority sanctions exactly these two contexts, and the client admits exactly the same two", () => {
    const sanctioned = KNOWN_CONTEXTS.filter((c) => resolvePolicy(c)!.localSufficient === true).sort();
    assert.deepEqual(sanctioned, ["interest", "language"]);
    assert.deepEqual([...CLIENT_CONTEXTS].sort(), ["interest", "language"]);
    for (const c of KNOWN_CONTEXTS) {
      const p = resolvePolicy(c)!;
      const facts = { ...(p as any), localSufficient: true, authoritative: true };
      assert.equal(localAnswerSuffices(facts), c === "language" || c === "interest", `client admits ${c}?`);
      assert.equal(sanctionLocalSufficiency({ ...p, localSufficient: true }), c === "language" || c === "interest", `server sanctions ${c}?`);
    }
  });
});

/**
 * Trips spec Appendix B — the reason-code vocabulary is one set, and the
 * envelope that carries it is additive.
 *
 * census-trips TR441-TR451 graded each family on whether a live refusal EMITS
 * a code from it. This file keeps three things true so that grading can be
 * repeated mechanically:
 *
 *   1. all eleven families are declared, each with at least one code;
 *   2. every `reason: "TRIP_…"` string anywhere in src/ (routes, lib,
 *      services) is in the vocabulary — a reason invented at a call site is a
 *      second vocabulary, and a second vocabulary is how TR441 happened;
 *   3. lib/tripKernel.ts's TripKernelReason is a SUBSET — the kernel file is
 *      read as text, the same way every kernel-family test reads its
 *      migration, so the kernel stays untouched and still cannot drift.
 *
 * And the honesty half: which declared codes NOTHING emits is printed, so
 * "declared" is never mistaken for "built".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  TRIP_REASON_CODES, TRIP_REASON_FAMILIES, TRIP_KERNEL_EXTENSION_CODES,
  INTERNAL_ONLY_REASONS, isKnownTripReason, tripReasonFamily, sendTripRefusal,
} from "../lib/tripReasonCodes.js";
import { sendError } from "../lib/http.js";

const SRC = new URL("../", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(p, out); }
    else if (/\.(ts|mjs|mts|sql)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every string literal shaped like a reason code that appears in src/ outside tests. */
function emittedReasons(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of walk(SRC)) {
    const text = readFileSync(f, "utf8");
    // A reason is EMITTED when it is the value of a `reason` key (TS), the
    // value beside the 'reason' key in a jsonb_build_object (SQL — that is
    // where the kernel refuses), the argument to sendTripRefusal, or a
    // `deny("…")` in lib/tripPolicy.ts — whose every return is forwarded to
    // the wire by a route through sendTripRefusal (check:trip-policy-callsites
    // is what keeps that true). A code that merely appears in a comment or a
    // type union is not an emission.
    const re = /(?:reason\s*[:=]\s*|'reason',\s*|sendTripRefusal\([^,]+,[^,]+,\s*|\bdeny\(\s*)["'](TRIP_[A-Z_]+)["']/g;
    for (const m of text.matchAll(re)) {
      const list = found.get(m[1]!) ?? [];
      list.push(f.slice(SRC.length));
      found.set(m[1]!, list);
    }
  }
  return found;
}

describe("the eleven families", () => {
  it("are all declared, each with at least one code", () => {
    assert.equal(TRIP_REASON_FAMILIES.length, 11);
    for (const fam of TRIP_REASON_FAMILIES) {
      const n = TRIP_REASON_CODES.filter((c) => c.startsWith(fam + "_")).length;
      assert.ok(n >= 1, `${fam} has no code`);
    }
  });
  it("every Appendix B code belongs to exactly one family", () => {
    for (const c of TRIP_REASON_CODES) {
      assert.ok(tripReasonFamily(c), `${c} belongs to no family`);
    }
  });
  it("extension codes are NOT filed under an Appendix B family", () => {
    // TRIP_PLAN_*, TRIP_LIFECYCLE_* etc. — the kernel's header records them as
    // owner decisions outside Appendix B. Filing one under TRIP_TEMPORAL_ or
    // TRIP_AUTH_ would misstate what was checked.
    for (const c of TRIP_KERNEL_EXTENSION_CODES) {
      assert.equal(tripReasonFamily(c), null, `${c} is an extension code that collides with a family prefix`);
    }
  });
  it("has no duplicates across the two lists", () => {
    const all = [...TRIP_REASON_CODES, ...TRIP_KERNEL_EXTENSION_CODES];
    assert.equal(new Set(all).size, all.length);
  });
});

describe("one vocabulary", () => {
  it("every reason the kernel can return is known here (kernel read as text)", () => {
    const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");
    const union = ts.slice(ts.indexOf("export type TripKernelReason ="), ts.indexOf("export type TripKernelResult"));
    const literals = [...union.matchAll(/\|\s*"(TRIP_[A-Z_]+)"/g)].map((m) => m[1]!);
    assert.ok(literals.length >= 35, `expected the kernel union to be large, read ${literals.length}`);
    const unknown = literals.filter((l) => !isKnownTripReason(l));
    assert.deepEqual(unknown, [], "kernel reasons the vocabulary does not know");
  });

  it("every reason EMITTED anywhere in src/ is known here", () => {
    const emitted = emittedReasons();
    assert.ok(emitted.size >= 20, `expected many emission sites, found ${emitted.size}`);
    const unknown = [...emitted.keys()].filter((r) => !isKnownTripReason(r));
    assert.deepEqual(unknown, [], "reasons emitted at a call site that the vocabulary does not declare");
  });

  it("reports which declared codes nothing emits — declared is not built", () => {
    const emitted = emittedReasons();
    const silent = TRIP_REASON_CODES.filter((c) => !emitted.has(c));
    const byFamily: Record<string, string[]> = {};
    for (const c of silent) (byFamily[tripReasonFamily(c)!] ??= []).push(c);
    console.log(`NOTE: ${silent.length} of ${TRIP_REASON_CODES.length} Appendix B codes are declared and never emitted:`);
    for (const [fam, codes] of Object.entries(byFamily)) console.log(`  ${fam}: ${codes.join(", ")}`);
    // Not an assertion on the count: it is a number the census reads, and a
    // ratchet on it belongs in a guard, not here. What IS asserted is that the
    // families this pass wired have at least one live emission each.
    for (const fam of ["TRIP_AUTH", "TRIP_PRIVACY", "TRIP_PRESENCE", "TRIP_BOOKING", "TRIP_VERSION", "TRIP_TEMPORAL", "TRIP_IDENTITY", "TRIP_PROJECTION"]) {
      const live = [...emitted.keys()].some((r) => r.startsWith(fam + "_"));
      assert.ok(live, `${fam} has no live emission anywhere in src/`);
    }
  });
});

describe("the envelope", () => {
  function res() {
    const out: { status?: number; body?: any } = {};
    const r: any = { status(n: number) { out.status = n; return r; }, json(b: any) { out.body = b; return r; } };
    return { r, out };
  }

  it("sendError without a reason is byte-identical to before: no `reason` key at all", () => {
    const { r, out } = res();
    sendError(r, "forbidden", "Not permitted");
    assert.deepEqual(out.body, { error: "forbidden", message: "Not permitted" });
    assert.equal(out.status, 403);
  });

  it("sendTripRefusal adds `reason` and changes nothing else", () => {
    const { r, out } = res();
    sendTripRefusal(r, "forbidden", "TRIP_AUTH_NOT_OWNER", "Only the trip owner can invite members");
    assert.deepEqual(out.body, { error: "forbidden", message: "Only the trip owner can invite members", reason: "TRIP_AUTH_NOT_OWNER" });
    assert.equal(out.status, 403);
  });

  it("a retryable code keeps its flag beside the reason", () => {
    const { r, out } = res();
    sendTripRefusal(r, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "try again");
    assert.deepEqual(out.body, { error: "degraded_unavailable", message: "try again", retryable: true, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("an internal-only reason is never put on the wire: it throws", () => {
    const { r, out } = res();
    assert.throws(() => sendTripRefusal(r, "not_found", "TRIP_AUTH_BLOCKED"), /internal-only/);
    assert.equal(out.body, undefined, "a body was written before the throw");
    assert.ok(INTERNAL_ONLY_REASONS.has("TRIP_AUTH_BLOCKED"));
  });
});

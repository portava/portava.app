/**
 * googlePlacesReason — the reasons behind the Google Places routes.
 *
 * WHAT THESE TESTS ARE ANCHORED TO
 * ================================
 * A real production defect, not a hypothetical. On 2026-08-15
 * `/api/places/google-autocomplete` returned `{"places":[],"powered_by":"google"}`
 * for Barcelona, Madrid and New York, with a `GOOGLE_MAPS_API_KEY` that was
 * demonstrably working — the Places API (New) photo route returned real photos
 * with the same key at the same minute.
 *
 * It was invisible because four distinct conditions shared one wire shape:
 * missing key, non-OK HTTP, non-OK status body, and a genuine no-match all
 * returned a bare empty list. Google's own `status` WAS being logged at
 * `places.ts:330` and was never read.
 *
 * The central case is therefore the one these tests protect hardest:
 *
 *   ZERO_RESULTS ("I looked, there is nothing")  MUST NOT look like
 *   REQUEST_DENIED ("I will not answer you").
 *
 * Folding those together is the original defect. Reporting ZERO_RESULTS as a
 * fault would be the same defect wearing the opposite sign.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_PREFIX,
  NEW_PREFIX,
  isProviderRefusal,
  legacyHttpReason,
  legacyStatusReason,
  newApiErrorReason,
} from "../lib/googlePlacesReason.js";

describe("legacyStatusReason — a real empty answer is not a fault", () => {
  it("OK yields no reason", () => {
    assert.equal(legacyStatusReason("OK"), null);
  });

  it("ZERO_RESULTS yields NO reason — Google looked and found nothing", () => {
    assert.equal(legacyStatusReason("ZERO_RESULTS"), null);
  });

  it("is case- and whitespace-insensitive about that, because upstreams drift", () => {
    assert.equal(legacyStatusReason(" zero_results "), null);
    assert.equal(legacyStatusReason("ok"), null);
  });
});

describe("legacyStatusReason — a refusal is reported, and says which", () => {
  it("REQUEST_DENIED — the status the live defect is believed to be returning", () => {
    assert.equal(legacyStatusReason("REQUEST_DENIED"), `${LEGACY_PREFIX}_request_denied`);
  });

  it("OVER_QUERY_LIMIT is distinct from REQUEST_DENIED", () => {
    const quota = legacyStatusReason("OVER_QUERY_LIMIT");
    const denied = legacyStatusReason("REQUEST_DENIED");
    assert.equal(quota, `${LEGACY_PREFIX}_over_query_limit`);
    assert.notEqual(quota, denied);
  });

  it("an UNKNOWN status is carried through rather than flattened", () => {
    // A status this build has never seen must not become a generic "error".
    // The whole point is that the operator learns what Google actually said.
    assert.equal(
      legacyStatusReason("SOME_FUTURE_STATUS"),
      `${LEGACY_PREFIX}_some_future_status`,
    );
  });

  it("a MISSING status is itself reportable — a failure to observe is not a pass", () => {
    for (const v of [undefined, null, ""]) {
      assert.equal(legacyStatusReason(v as string | null | undefined), `${LEGACY_PREFIX}_no_status`);
    }
  });
});

describe("THE DEFECT ITSELF: the four conditions must not collapse", () => {
  it("no-match, refusal, quota and unparseable are four DISTINCT values", () => {
    const noMatch = legacyStatusReason("ZERO_RESULTS");
    const refusal = legacyStatusReason("REQUEST_DENIED");
    const quota = legacyStatusReason("OVER_QUERY_LIMIT");
    const unparseable = legacyStatusReason(undefined);
    const http = legacyHttpReason(503);

    const all = [noMatch, refusal, quota, unparseable, http];
    assert.equal(new Set(all).size, all.length, "two conditions share a reason — that is the bug");
  });

  it("and only ONE of them means 'nothing is wrong'", () => {
    assert.equal(isProviderRefusal(legacyStatusReason("ZERO_RESULTS")), false);
    assert.equal(isProviderRefusal(legacyStatusReason("REQUEST_DENIED")), true);
    assert.equal(isProviderRefusal(legacyStatusReason(undefined)), true);
    assert.equal(isProviderRefusal(legacyHttpReason(503)), true);
  });
});

describe("legacyHttpReason", () => {
  it("carries the HTTP code, which used to be thrown away by a generic throw", () => {
    assert.equal(legacyHttpReason(403), `${LEGACY_PREFIX}_http_403`);
    assert.equal(legacyHttpReason(500), `${LEGACY_PREFIX}_http_500`);
  });
});

describe("newApiErrorReason — the surface the routes are migrating to", () => {
  it("prefers the detail reason, which is the actionable one", () => {
    const body = {
      error: {
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    };
    assert.equal(newApiErrorReason(body, 403), `${NEW_PREFIX}_service_disabled`);
  });

  it("falls back to error.status when no detail reason is present", () => {
    assert.equal(
      newApiErrorReason({ error: { status: "PERMISSION_DENIED" } }, 403),
      `${NEW_PREFIX}_permission_denied`,
    );
  });

  it("falls back to the HTTP code when the body is unusable", () => {
    for (const body of [null, undefined, {}, { error: {} }, "not json"]) {
      assert.equal(newApiErrorReason(body, 502), `${NEW_PREFIX}_http_502`);
    }
  });

  it("skips a detail entry that has no reason rather than emitting an empty suffix", () => {
    const body = { error: { status: "PERMISSION_DENIED", details: [{}, { reason: "API_KEY_INVALID" }] } };
    assert.equal(newApiErrorReason(body, 403), `${NEW_PREFIX}_api_key_invalid`);
  });

  it("never emits a trailing or doubled separator from a messy status", () => {
    const r = newApiErrorReason({ error: { status: "  WEIRD -- STATUS  " } }, 400);
    assert.equal(r, `${NEW_PREFIX}_weird_status`);
    assert.ok(!r.endsWith("_"), "trailing separator");
    assert.ok(!r.includes("__"), "doubled separator");
  });
});

describe("isProviderRefusal — the predicate a health check should use", () => {
  it("null (no failure) is not a refusal", () => {
    assert.equal(isProviderRefusal(null), false);
  });

  it("a transport failure is not classified as a provider refusal", () => {
    // `request_failed` means we never got an answer. It is a real failure, but
    // it is not the provider declining, and conflating them would send someone
    // to the Google Cloud console over a network blip.
    assert.equal(isProviderRefusal("request_failed"), false);
  });

  it("both provider surfaces are recognised", () => {
    assert.equal(isProviderRefusal(legacyStatusReason("REQUEST_DENIED")), true);
    assert.equal(isProviderRefusal(newApiErrorReason({ error: { status: "PERMISSION_DENIED" } }, 403)), true);
  });
});

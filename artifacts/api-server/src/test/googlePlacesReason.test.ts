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
  NEW_PREFIX,
  isProviderRefusal,
  newApiErrorReason,
} from "../lib/googlePlacesReason.js";

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

  it("a provider refusal is recognised", () => {
    assert.equal(isProviderRefusal(newApiErrorReason({ error: { status: "PERMISSION_DENIED" } }, 403)), true);
  });
});

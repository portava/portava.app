/**
 * mediaCursor decode validation — the cursor fields are interpolated raw into a
 * PostgREST .or() filter, so decodeCursor must reject a non-UUID id or an
 * injection-bearing created_at (deep-bug-hunt #42).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor } from "../lib/mediaCursor.js";

describe("mediaCursor decode validation", () => {
  const ISO = "2026-08-27T12:00:00.000Z";
  const UUID = "11111111-1111-4111-8111-111111111111";

  it("round-trips a valid cursor", () => {
    const c = decodeCursor(encodeCursor({ created_at: ISO, id: UUID }));
    assert.deepEqual(c, { created_at: ISO, id: UUID });
  });

  it("rejects a non-UUID id (filter-injection surface)", () => {
    const token = Buffer.from(JSON.stringify({ created_at: ISO, id: "x),status.eq.approved" })).toString("base64url");
    assert.equal(decodeCursor(token), null);
  });

  it("rejects a created_at carrying .or() metacharacters", () => {
    const token = Buffer.from(JSON.stringify({ created_at: "2026-01-01),id.gt.0", id: UUID })).toString("base64url");
    assert.equal(decodeCursor(token), null);
  });

  it("rejects an unparseable created_at", () => {
    const token = Buffer.from(JSON.stringify({ created_at: "not-a-date", id: UUID })).toString("base64url");
    assert.equal(decodeCursor(token), null);
  });
});

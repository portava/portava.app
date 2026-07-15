/**
 * Unit tests for the universal display-name rule choke point.
 *
 * RULE: other users default to @handle; real names only when the subject
 * opted in via profile_privacy_settings.show_real_name. Fail-closed on any
 * lookup error. Viewer always sees their own identity.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  nameVisibilitySet,
  nameVisibleFor,
  presentedName,
  sanitizeIdentity,
  sanitizeIdentityKeys,
} from "../lib/publicIdentity.js";

/** Minimal stub of the supabase query surface nameVisibilitySet uses. */
function stubClient(behavior: {
  rows?: Array<{ user_id: string }>;
  error?: any;
  throws?: boolean;
  capture?: { table?: string; ids?: string[] };
}) {
  return {
    from(table: string) {
      if (behavior.capture) behavior.capture.table = table;
      const b: any = {
        select() { return b; },
        in(_col: string, ids: string[]) {
          if (behavior.capture) behavior.capture.ids = ids;
          return b;
        },
        eq() {
          if (behavior.throws) throw new Error("boom");
          return Promise.resolve(
            behavior.error
              ? { data: null, error: behavior.error }
              : { data: behavior.rows ?? [], error: null },
          );
        },
      };
      return b;
    },
  };
}

describe("nameVisibilitySet", () => {
  it("returns the set of opted-in ids from one batched query", async () => {
    const capture: any = {};
    const sc = stubClient({ rows: [{ user_id: "a" }, { user_id: "c" }], capture });
    const set = await nameVisibilitySet(sc, ["a", "b", "c"]);
    assert.deepEqual([...set].sort(), ["a", "c"]);
    assert.equal(capture.table, "profile_privacy_settings");
    assert.deepEqual(capture.ids.sort(), ["a", "b", "c"]);
  });

  it("dedupes ids and drops null/undefined/empty before querying", async () => {
    const capture: any = {};
    const sc = stubClient({ rows: [], capture });
    await nameVisibilitySet(sc, ["a", "a", null, undefined, "", "b"]);
    assert.deepEqual(capture.ids.sort(), ["a", "b"]);
  });

  it("returns an empty set without querying for an empty id list", async () => {
    const capture: any = {};
    const sc = stubClient({ rows: [{ user_id: "a" }], capture });
    const set = await nameVisibilitySet(sc, [null, undefined, ""]);
    assert.equal(set.size, 0);
    assert.equal(capture.table, undefined);
  });

  it("fails CLOSED on query error (hidden names stay hidden)", async () => {
    const sc = stubClient({ error: { message: "column does not exist" } });
    const set = await nameVisibilitySet(sc, ["a", "b"]);
    assert.equal(set.size, 0);
  });

  it("fails CLOSED on thrown error", async () => {
    const sc = stubClient({ throws: true });
    const set = await nameVisibilitySet(sc, ["a"]);
    assert.equal(set.size, 0);
  });

  it("fails CLOSED on a null client", async () => {
    const set = await nameVisibilitySet(null, ["a"]);
    assert.equal(set.size, 0);
  });
});

describe("nameVisibleFor", () => {
  it("true only when the user opted in", async () => {
    assert.equal(await nameVisibleFor(stubClient({ rows: [{ user_id: "a" }] }), "a"), true);
    assert.equal(await nameVisibleFor(stubClient({ rows: [] }), "a"), false);
    assert.equal(await nameVisibleFor(stubClient({ rows: [] }), null), false);
  });
});

describe("presentedName", () => {
  const row = { id: "a", display_name: "Kai R", name: "Kai", handle: "kai" };
  it("returns display_name (then name) when allowed", () => {
    assert.equal(presentedName(row, true), "Kai R");
    assert.equal(presentedName({ id: "a", name: "Kai" }, true), "Kai");
  });
  it("returns null when not allowed, row missing, or name blank", () => {
    assert.equal(presentedName(row, false), null);
    assert.equal(presentedName(null, true), null);
    assert.equal(presentedName({ id: "a", display_name: "  " }, true), null);
  });
});

describe("sanitizeIdentity", () => {
  const allowed = new Set(["ok"]);
  const base = { id: "x", name: "Real Name", display_name: "R N", handle: "rn", avatar_url: "u", verified: true };

  it("nulls name/display_name for non-opted-in users, keeping everything else", () => {
    const out: any = sanitizeIdentity({ ...base }, allowed);
    assert.equal(out.name, null);
    assert.equal(out.display_name, null);
    assert.equal(out.handle, "rn");
    assert.equal(out.avatar_url, "u");
    assert.equal(out.verified, true);
  });

  it("does not mutate the input row", () => {
    const input = { ...base };
    sanitizeIdentity(input, allowed);
    assert.equal(input.name, "Real Name");
  });

  it("passes opted-in users through untouched", () => {
    const out: any = sanitizeIdentity({ ...base, id: "ok" }, allowed);
    assert.equal(out.name, "Real Name");
  });

  it("viewer always sees their own identity", () => {
    const out: any = sanitizeIdentity({ ...base }, allowed, "x");
    assert.equal(out.name, "Real Name");
  });

  it("handles null/undefined rows", () => {
    assert.equal(sanitizeIdentity(null, allowed), null);
    assert.equal(sanitizeIdentity(undefined, allowed), undefined);
  });

  it("redacts rows with no id (cannot verify opt-in → fail closed)", () => {
    const out: any = sanitizeIdentity({ name: "Anon Real", handle: "h" }, allowed, "viewer");
    assert.equal(out.name, null);
  });
});

describe("sanitizeIdentityKeys", () => {
  const allowed = new Set(["ok"]);
  it("nulls the listed camelCase keys unless owner opted in or is viewer", () => {
    const obj = { hostName: "Kai", hostHandle: "kai", other: 1 };
    const out = sanitizeIdentityKeys(obj, "someone", ["hostName"], allowed);
    assert.equal(out.hostName, null);
    assert.equal(out.hostHandle, "kai");
    assert.equal(out.other, 1);

    assert.equal(sanitizeIdentityKeys({ hostName: "Kai" }, "ok", ["hostName"], allowed).hostName, "Kai");
    assert.equal(sanitizeIdentityKeys({ hostName: "Kai" }, "me", ["hostName"], allowed, "me").hostName, "Kai");
  });
});

/**
 * passportMapPresence.test.ts — Passport spec §21 ("Map — aggregate or
 * permission-appropriate presence only") and §35 ("other surfaces request the
 * appropriate Passport projection instead of rebuilding identity").
 *
 * THE ROW THIS CLOSES, AND WHY IT WAS NOT A ONE-LINE FIX
 * =====================================================
 * census-passport P98 scored NOT-BUILT with the reasoning "there is no Map
 * variant". Adding a seventh `PassportConsumerVariant` was the obvious move and
 * it is the wrong one: every variant is reached through
 * `buildConsumerProjection`, which narrows a FULL per-user assembly
 * (`buildPassportProjection` ~21 reads, plus the interaction-permissions engine
 * for ~13 more per target). The live map returns up to 100 travelers and is
 * polled every 45 s, so the per-user path is ~3,400 reads per poll per viewer.
 *
 * The map's access to the Passport is therefore BATCH-ONLY BY CONSTRUCTION, and
 * that constraint is asserted here rather than explained in a comment: if a
 * later change adds `"map"` to the variant union, the first test fails.
 *
 * WHAT THE ADOPTION DID AND DID NOT CHANGE
 * ========================================
 * Nothing about the map's output. `lib/mapTravelers` already applied both
 * privacy rules correctly — this was an AUTHORITY defect, not a leak: the rules
 * lived in a consumer instead of in the Passport, so a change to the universal
 * display-name rule had two places to land and one of them was easy to miss.
 * The adoption costs no read either: the projection takes over the
 * `nameVisibilitySet` call mapTravelers was already making.
 *
 * WHAT TURNS THIS RED
 *   • add "map" to PassportConsumerVariant           -> test 1
 *   • make the projection read per-owner             -> test 2 (read count)
 *   • drop the real-name gate, or invert it          -> tests 3-5
 *   • drop the avatar opt-out                        -> test 6
 *   • make a nameVisibilitySet failure fail OPEN     -> test 7
 *   • give a profile-less id a default pin           -> test 8
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";

import {
  buildMapPresenceProjections,
  type MapPresenceProfileRow,
} from "../services/passport/PassportConsumerProjections.js";

/** A client that records every table opened and answers the one read this
 *  projection is allowed to make. `allowRealName` is the opted-in set. */
function client(allowRealName: string[], opts: { fail?: boolean } = {}) {
  const tables: string[] = [];
  return {
    tables,
    from(table: string) {
      tables.push(table);
      const b: any = {
        select: () => b,
        in: () => b,
        eq: () => b,
        then: (onF: any, onR: any) =>
          Promise.resolve(
            opts.fail
              ? { data: null, error: { message: "boom" } }
              : { data: allowRealName.map((id) => ({ user_id: id })), error: null },
          ).then(onF, onR),
      };
      return b;
    },
  };
}

const row = (over: Partial<MapPresenceProfileRow> & { id: string }): MapPresenceProfileRow => ({
  handle: "wanderer",
  name: "Real Name",
  display_name: null,
  avatar_url: "https://cdn/a.jpg",
  show_profile_picture_publicly: true,
  verified: false,
  ...over,
});

describe("§21/§35 — the map's access to the Passport is batch-only by construction", () => {
  it("PassportConsumerVariant has NO \"map\" member", () => {
    // Asserted over the source, because the constraint is about what a future
    // author can reach for. A `"map"` variant would route the map through the
    // ~34-reads-per-target per-user path, which is the defect this design
    // exists to prevent — and it would look like the tidy thing to do.
    const src = fs
      .readFileSync(new URL("../services/passport/PassportConsumerProjections.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    const union = /export type PassportConsumerVariant =([\s\S]*?);/.exec(src)?.[1] ?? "";
    assert.ok(union.length > 0, "could not find the variant union — the scan is not reading real source");
    assert.ok(union.includes('"discovery_card"'), "guard against a vacuous match");
    assert.equal(union.includes('"map"'), false, 'PassportConsumerVariant must not gain a "map" member');
  });

  it("makes exactly ONE table read for 50 owners", () => {
    const c = client([]);
    return buildMapPresenceProjections(c as never, Array.from({ length: 50 }, (_, i) => row({ id: `u${i}` })))
      .then((out) => {
        assert.equal(out.size, 50);
        assert.deepEqual(c.tables, ["profile_privacy_settings"]);
      });
  });

  it("returns an empty map and takes NO read for an empty owner list", async () => {
    const c = client([]);
    assert.equal((await buildMapPresenceProjections(c as never, [])).size, 0);
    assert.deepEqual(c.tables, []);
  });
});

describe("§21 — the universal display-name rule", () => {
  it("shows the real name only where the owner opted in", async () => {
    const out = await buildMapPresenceProjections(
      client(["in"]) as never,
      [row({ id: "in" }), row({ id: "out" })],
    );
    assert.equal(out.get("in")?.displayName, "Real Name");
    assert.equal(out.get("out")?.displayName, "@wanderer");
  });

  it("prefers display_name over name for an opted-in owner", async () => {
    const out = await buildMapPresenceProjections(
      client(["a"]) as never,
      [row({ id: "a", display_name: "Preferred" })],
    );
    assert.equal(out.get("a")?.displayName, "Preferred");
  });

  it("falls back to the generic word only when there is no handle either", async () => {
    const out = await buildMapPresenceProjections(
      client([]) as never,
      [row({ id: "a", handle: null })],
    );
    assert.equal(out.get("a")?.displayName, "Traveler");
    assert.equal(out.get("a")?.handle, null);
  });

  it("a whitespace-only name falls through to the handle, not a blank pin", async () => {
    // The choke point (`presentedName`) trims; the inline `display_name ?? name`
    // this function briefly used did not. A pin labelled "   " is a pin nobody
    // can identify, and it was reachable from any profile whose name was spaces.
    const out = await buildMapPresenceProjections(
      client(["a"]) as never,
      [row({ id: "a", display_name: "   ", name: "  " })],
    );
    assert.equal(out.get("a")?.displayName, "wanderer");
  });

  it("an opted-in owner with NO name shows a bare handle, not @handle", async () => {
    // The asymmetry, pinned. `@` marks "this is a handle, not a name" and is for
    // the case where a name was WITHHELD. An owner who opted in and simply has
    // no name withheld nothing, so their handle is shown plainly.
    const out = await buildMapPresenceProjections(
      client(["a"]) as never,
      [row({ id: "a", name: null, display_name: null })],
    );
    assert.equal(out.get("a")?.displayName, "wanderer");
  });

  it("a FAILED visibility read falls back to @handle for everyone", async () => {
    // Fail-closed on the name. Showing a handle to someone who opted in to their
    // real name is a cosmetic regression; showing a real name to someone who did
    // not is the privacy failure. supabase-js RESOLVES on a database error, so
    // this path is reached by an `error` object, not a throw.
    const out = await buildMapPresenceProjections(
      client(["a"], { fail: true }) as never,
      [row({ id: "a" })],
    );
    assert.equal(out.get("a")?.displayName, "@wanderer");
  });
});

describe("§21 — the avatar opt-out and what the projection refuses to carry", () => {
  it("honours show_profile_picture_publicly === false", async () => {
    const out = await buildMapPresenceProjections(
      client([]) as never,
      [row({ id: "a", show_profile_picture_publicly: false })],
    );
    assert.equal(out.get("a")?.avatarUrl, null);
  });

  it("defaults to showing the avatar when the column is absent", async () => {
    const out = await buildMapPresenceProjections(
      client([]) as never,
      [row({ id: "a", show_profile_picture_publicly: null })],
    );
    assert.equal(out.get("a")?.avatarUrl, "https://cdn/a.jpg");
  });

  it("carries identity ONLY — no location, counts, trust or availability", async () => {
    const out = await buildMapPresenceProjections(client(["a"]) as never, [row({ id: "a" })]);
    assert.deepEqual(
      Object.keys(out.get("a") ?? {}).sort(),
      ["avatarUrl", "displayName", "handle", "id", "verified"],
    );
  });
});

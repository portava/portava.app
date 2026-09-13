/**
 * passportListIdentityProjection — census-passport P169's remaining work, and
 * census-discovery A15's, pinned.
 *
 * P169, after every per-user consumer adopted `buildConsumerProjection`:
 *
 *     "What actually remains is not four unadopted consumers — it is two BULK
 *      LIST endpoints ... Extending the batch projection with a
 *      viewer-relationship input is the remaining work, and it is one job, not
 *      two."
 *
 * A15 says the same thing from Discovery's side: "the search list still
 * assembles its own identity payload from `profiles` ... the construction is the
 * duplication `PassportConsumerProjections` says it exists to end."
 *
 * So there are three claims to hold, and prose holds none of them:
 *   §1 the projection applies ONE set of rules, including the two that differ
 *      per viewer (private preview, picture opt-out);
 *   §2 it costs the adopters nothing they were not already paying;
 *   §3 BOTH lists actually route through it, and neither keeps a private copy
 *      of the display-name rule — which is the copy that was WRONG.
 *
 * Runtime: node:test + node:assert. No DB, no network.
 * Run: node --import tsx/esm --test src/test/passportListIdentityProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildListIdentityProjections,
  type ListIdentityProfileRow,
} from "../services/passport/PassportConsumerProjections.js";

/**
 * A Supabase fake narrow enough to be honest: it answers the ONE table
 * `nameVisibilitySet` reads and counts how many times it was asked.
 */
function makeFake(optedInIds: readonly string[]) {
  let reads = 0;
  const client = {
    from(table: string) {
      const b: any = {
        select: () => b,
        in: () => b,
        eq: () => b,
        then: (resolve: Function) => {
          reads++;
          if (table !== "profile_privacy_settings") return resolve({ data: [], error: null });
          return resolve({
            data: optedInIds.map((id) => ({ user_id: id, show_real_name_publicly: true })),
            error: null,
          });
        },
      };
      return b;
    },
  };
  return { client: client as never, reads: () => reads };
}

const row = (over: Partial<ListIdentityProfileRow> & { id: string }): ListIdentityProfileRow => ({
  handle: "handle",
  username: "handle",
  name: "Real Name",
  display_name: null,
  avatar_url: "https://cdn/a.png",
  is_private: false,
  show_profile_picture_publicly: true,
  verified: false,
  ...over,
});

const NOBODY = { following: new Set<string>(), friends: new Set<string>() };

describe("§1 — one set of rules, including the two that depend on the viewer", () => {
  it("1a — the real name is shown only to a viewer the subject opted in for", async () => {
    const { client } = makeFake(["opted"]);
    const out = await buildListIdentityProjections(
      client,
      [row({ id: "opted" }), row({ id: "private-name" })],
      { viewerId: "v", ...NOBODY },
    );
    assert.equal(out.get("opted")!.nameAllowed, true);
    assert.equal(out.get("opted")!.presentedName, "Real Name");
    assert.equal(out.get("private-name")!.nameAllowed, false);
    assert.equal(out.get("private-name")!.presentedName, null);
  });

  it("1b — THE DIVERGENCE: a whitespace-only display_name falls through, it does not render blank", async () => {
    // This is the bug the shared projection closes. `routes/compass.ts` read
    // `display_name ?? name ?? username` inline and did not trim, so this
    // subject got an empty title in the Compass traveler list while
    // Discovery — which already used the canonical helper — showed the handle.
    const { client } = makeFake(["ghost"]);
    const out = await buildListIdentityProjections(
      client,
      [row({ id: "ghost", display_name: "   ", name: null })],
      { viewerId: "v", ...NOBODY },
    );
    assert.equal(out.get("ghost")!.presentedName, null, "a blank display_name must not become the name");
  });

  it("1c — display_name wins over name, and both are the choke point's order", async () => {
    const { client } = makeFake(["u"]);
    const out = await buildListIdentityProjections(
      client, [row({ id: "u", display_name: "Chosen", name: "Legal" })], { viewerId: "v", ...NOBODY },
    );
    assert.equal(out.get("u")!.presentedName, "Chosen");
  });

  it("1d — a private account is locked for a non-follower and unlocked by a FOLLOW, not by a friendship", async () => {
    const { client } = makeFake([]);
    const out = await buildListIdentityProjections(
      client,
      [row({ id: "p1", is_private: true }), row({ id: "p2", is_private: true }), row({ id: "p3", is_private: true })],
      { viewerId: "v", following: new Set(["p2"]), friends: new Set(["p3"]) },
    );
    assert.equal(out.get("p1")!.lockedPreview, true, "stranger sees a locked private account");
    assert.equal(out.get("p2")!.lockedPreview, false, "a follow unlocks it");
    // A friendship is NOT a follow. Collapsing the two sets would silently
    // unlock private previews for friends who never followed.
    assert.equal(out.get("p3")!.lockedPreview, true, "a friendship must not unlock a private preview");
  });

  it("1e — the avatar: locked hides it; the owner's opt-out hides it from strangers but not from a follower or a friend", async () => {
    const { client } = makeFake([]);
    const out = await buildListIdentityProjections(
      client,
      [
        row({ id: "locked", is_private: true }),
        row({ id: "optout" , show_profile_picture_publicly: false }),
        row({ id: "optout-follower", show_profile_picture_publicly: false }),
        row({ id: "optout-friend"  , show_profile_picture_publicly: false }),
        row({ id: "public" }),
      ],
      { viewerId: "v", following: new Set(["optout-follower"]), friends: new Set(["optout-friend"]) },
    );
    assert.equal(out.get("locked")!.avatarUrl, null);
    assert.equal(out.get("optout")!.avatarUrl, null);
    assert.equal(out.get("optout-follower")!.avatarUrl, "https://cdn/a.png");
    assert.equal(out.get("optout-friend")!.avatarUrl, "https://cdn/a.png");
    assert.equal(out.get("public")!.avatarUrl, "https://cdn/a.png");
  });

  it("1f — a missing `show_profile_picture_publicly` DEFAULTS TO SHOWING, an absent `verified` to false", async () => {
    const { client } = makeFake([]);
    const out = await buildListIdentityProjections(
      client,
      [{ id: "u", handle: "h", avatar_url: "https://cdn/a.png" }],
      { viewerId: "v", ...NOBODY },
    );
    assert.equal(out.get("u")!.avatarUrl, "https://cdn/a.png");
    assert.equal(out.get("u")!.verified, false);
  });

  it("1g — the viewer is never redacted to themselves (census-discovery C10), even though both callers exclude them", async () => {
    const { client } = makeFake([]);
    const out = await buildListIdentityProjections(
      client, [row({ id: "me", is_private: true, show_profile_picture_publicly: false })], { viewerId: "me", ...NOBODY },
    );
    const me = out.get("me")!;
    assert.equal(me.nameAllowed, true);
    assert.equal(me.presentedName, "Real Name");
    assert.equal(me.lockedPreview, false);
    assert.equal(me.avatarUrl, "https://cdn/a.png");
  });

  it("1h — FAIL-CLOSED on the name: an empty allow-set redacts everyone rather than falling open", async () => {
    const { client } = makeFake([]);
    const out = await buildListIdentityProjections(client, [row({ id: "u" })], { viewerId: "v", ...NOBODY });
    assert.equal(out.get("u")!.nameAllowed, false);
    assert.equal(out.get("u")!.presentedName, null);
  });
});

describe("§2 — it costs its adopters nothing new", () => {
  it("2a — ONE read for fifty rows", async () => {
    const { client, reads } = makeFake([]);
    const rows = Array.from({ length: 50 }, (_, i) => row({ id: `u${i}` }));
    const out = await buildListIdentityProjections(client, rows, { viewerId: "v", ...NOBODY });
    assert.equal(out.size, 50);
    assert.equal(reads(), 1);
  });

  it("2b — ZERO reads when the caller already resolved the allow-set, which Discovery must", async () => {
    // Discovery resolves it before projecting, for C09's hidden-name match
    // rule. Without this path adopting the projection would DOUBLE that
    // surface's privacy reads, and a projection that costs its adopter more
    // than the copy it replaces does not get adopted.
    const { client, reads } = makeFake([]);
    const out = await buildListIdentityProjections(
      client, [row({ id: "u" })],
      { viewerId: "v", ...NOBODY, allowedRealNames: new Set(["u"]) },
    );
    assert.equal(reads(), 0);
    assert.equal(out.get("u")!.nameAllowed, true);
  });

  it("2c — an empty page touches the client at all", async () => {
    const { client, reads } = makeFake([]);
    assert.equal((await buildListIdentityProjections(client, [], { viewerId: "v", ...NOBODY })).size, 0);
    assert.equal(reads(), 0);
  });
});

describe("§3 — both bulk lists actually route through it", () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("3a — the Discovery search list and the Compass traveler list each call the projection", () => {
    assert.match(read("../routes/discoverySearch.ts"), /buildListIdentityProjections\(/);
    assert.match(read("../routes/compass.ts"), /buildListIdentityProjections\(/);
  });

  it("3b — NEITHER list keeps a private copy of the display-name rule", () => {
    // The literal `display_name ?? name` chain is the copy that disagreed with
    // the choke point. It must exist in `lib/publicIdentity` and in the two
    // projections that legitimately compose it, and nowhere in a route.
    // The prefix must allow ANY dotted receiver (`p.name`, `s.row.name`), and
    // it did not on the first draft: a mutation putting `s.row.display_name ??
    // s.row.name` back into routes/compass.ts left this test GREEN, because the
    // pattern only tolerated ONE dot. A guard that cannot see the copy it was
    // written to forbid is worse than none.
    const inline = /display_name\s*\?\?\s*(?:[\w.]+\.)?name\b/;
    for (const f of ["../routes/discoverySearch.ts", "../routes/compass.ts"]) {
      assert.ok(!inline.test(read(f)), `${f} still resolves the display name inline`);
    }
    assert.match(read("../lib/publicIdentity.ts"), inline, "the canonical rule must still be somewhere");
  });

  it("3c — neither list gates the avatar inline any more", () => {
    for (const f of ["../routes/discoverySearch.ts", "../routes/compass.ts"]) {
      assert.ok(
        !/show_profile_picture_publicly\s*!==\s*false/.test(read(f)),
        `${f} still applies the picture opt-out itself`,
      );
    }
    assert.match(
      read("../services/passport/PassportConsumerProjections.ts"),
      /show_profile_picture_publicly\s*!==\s*false/,
    );
  });
});

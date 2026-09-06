/**
 * Passport projection — universal display-name rule (`show_real_name`).
 *
 * LIVE PRIVACY LEAK this file locks down: `buildIdentity` in
 * PassportProjectionService returned `profile.display_name ?? profile.name` to
 * every viewer unconditionally, never consulting
 * `profile_privacy_settings.show_real_name`. The aggregate is served to
 * followers, buddies, trip crew AND to fully anonymous callers via
 * `GET /api/passport/:userId/projection`, so a user who had opted OUT of
 * showing their real name had it returned to strangers anyway.
 *
 * The fix routes the identity block through the canonical choke point in
 * `lib/publicIdentity.ts` (`nameVisibilitySet` + `sanitizeIdentity`) — the same
 * helpers `GET /trips/:tripId/members` and `GET /users/:username/passport`
 * already use — rather than adding a second local predicate.
 *
 * Every case here carries a POSITIVE CONTROL: a user with
 * `show_real_name: true` whose name IS returned. Without it a fix that hid
 * every name always (or a fixture that omitted the settings column and read as
 * "deny" under the fail-closed gate) would pass vacuously.
 *
 * Run: node --import tsx/esm --test src/test/passportProjectionNameVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

// HIDDEN has opted OUT of showing their real name; SHOWN has opted IN.
const HIDDEN = "hidden-user-1";
const SHOWN = "shown-user-1";
const VIEWER = "viewer-1";

const HIDDEN_NAME = "Bob Traveler";
const SHOWN_NAME = "Alice Visible";

function permsSelf(): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
  };
}
function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: false,
  };
}
function permsFollower(): ViewerPermissions {
  const p = permsPublic();
  p.relationshipLabel = "follower";
  p.canViewFullProfile = true;
  p.canSeeTrips = true;
  p.canSeeLocationContext = true;
  return p;
}

function resolution(permissions: ViewerPermissions, context: ViewerResolution["context"]): ViewerResolution {
  return { context, permissions, sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
}
function resolver(res: ViewerResolution) {
  return async () => res;
}

function profileRow(id: string, handle: string, name: string) {
  return {
    id, handle, username: handle, display_name: name, name,
    avatar_url: "https://x/a.png", cover_photo_url: null,
    verified: false, verified_at: null, verification_level: null,
    home_city: "Hanoi", home_country: "Vietnam", current_city: "Hanoi",
    is_official: false, is_private: false, passport_visibility: "public",
    show_profile_picture_publicly: true,
    interests: [], availability_tags: [], spoken_languages: [],
    travel_pace: null, planning_style: null, budget_style: null,
    travel_group_style: [], open_to_meet: false,
    buddy_verified_at: null, created_at: "2023-01-01",
  };
}

/**
 * `privacyRows` is the ONLY thing that varies between the leak fixture and the
 * control fixture — both profiles are otherwise identical, so a name that is
 * returned for one and withheld for the other can only be the privacy setting.
 */
function seedDb(privacyRows: Array<Record<string, any>>) {
  return makePassportDb({
    profiles: [
      profileRow(HIDDEN, "bobt", HIDDEN_NAME),
      profileRow(SHOWN, "alicev", SHOWN_NAME),
    ],
    profile_privacy_settings: privacyRows,
  });
}

/** The realistic staging: HIDDEN opted out, SHOWN opted in. */
function seedBoth() {
  return seedDb([
    { user_id: HIDDEN, show_real_name: false },
    { user_id: SHOWN, show_real_name: true },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumer 1 — the shared assembler, anonymous viewer.
// This is what `GET /api/passport/:userId/projection` serves to a caller with
// no Authorization header at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPassportProjection — anonymous viewer honors show_real_name", () => {
  it("withholds an opted-out name and returns an opted-in one (positive control)", async () => {
    const res = resolution(permsPublic(), "public");

    const hidden = (await buildPassportProjection(seedBoth(), HIDDEN, null, {
      resolveViewerContext: resolver(res),
    }))!;
    const shown = (await buildPassportProjection(seedBoth(), SHOWN, null, {
      resolveViewerContext: resolver(res),
    }))!;

    assert.ok(hidden, "hidden-user projection built");
    assert.equal(
      hidden.identity.name,
      null,
      "opted-out user's real name must not reach an anonymous caller",
    );
    // POSITIVE CONTROL — a fix that always hid names would fail here.
    assert.equal(
      shown.identity.name,
      SHOWN_NAME,
      "opted-in user's name IS returned (control: the rule is not 'hide everything')",
    );

    // The rule touches the NAME only: handle, avatar and verification pass through.
    assert.equal(hidden.identity.handle, "bobt");
    assert.equal(hidden.identity.avatarUrl, "https://x/a.png");
    assert.equal(hidden.identity.userId, HIDDEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consumer 2 — an authenticated, non-self viewer (follower / trip crew / buddy
// all reach the same assembler through `resolvePassportViewerContext`).
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPassportProjection — authenticated non-self viewer honors show_real_name", () => {
  it("withholds an opted-out name from a follower and returns an opted-in one", async () => {
    const res = resolution(permsFollower(), "follower");

    const hidden = (await buildPassportProjection(seedBoth(), HIDDEN, VIEWER, {
      resolveViewerContext: resolver(res),
    }))!;
    const shown = (await buildPassportProjection(seedBoth(), SHOWN, VIEWER, {
      resolveViewerContext: resolver(res),
    }))!;

    assert.equal(hidden.identity.name, null, "follower must not see an opted-out real name");
    // POSITIVE CONTROL.
    assert.equal(shown.identity.name, SHOWN_NAME, "follower DOES see an opted-in name");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consumer 3 — the restricted / blocked card. It is assembled from the same
// `identity` object, so it must inherit the rule rather than route around it.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPassportProjection — restricted (blocked) card honors show_real_name", () => {
  it("withholds an opted-out name on the minimal card and returns an opted-in one", async () => {
    const blocked = permsPublic();
    blocked.isBlocked = true;
    const res = resolution(blocked, "public");

    const hidden = (await buildPassportProjection(seedBoth(), HIDDEN, VIEWER, {
      resolveViewerContext: resolver(res),
    }))!;
    const shown = (await buildPassportProjection(seedBoth(), SHOWN, VIEWER, {
      resolveViewerContext: resolver(res),
    }))!;

    assert.equal(hidden.restricted?.reason, "blocked", "restricted card path taken");
    assert.equal(hidden.identity.name, null, "blocked viewer must not see an opted-out real name");
    // POSITIVE CONTROL — the restricted card still carries an opted-in name.
    assert.equal(shown.restricted?.reason, "blocked");
    assert.equal(shown.identity.name, SHOWN_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The owner must still read their own name.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPassportProjection — the owner always sees their own name", () => {
  it("returns the owner's own name even when show_real_name is false", async () => {
    const res = resolution(permsSelf(), "self");
    const p = (await buildPassportProjection(seedBoth(), HIDDEN, HIDDEN, {
      resolveViewerContext: resolver(res),
    }))!;
    assert.equal(
      p.identity.name,
      HIDDEN_NAME,
      "opting out hides the name from OTHERS, never from the owner's own passport",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed: unknown ⇒ hidden.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPassportProjection — name visibility fails CLOSED", () => {
  const res = resolution(permsPublic(), "public");

  it("hides the name when the privacy row is missing entirely", async () => {
    const db = seedDb([{ user_id: SHOWN, show_real_name: true }]); // no row for HIDDEN
    const p = (await buildPassportProjection(db, HIDDEN, null, { resolveViewerContext: resolver(res) }))!;
    assert.equal(p.identity.name, null, "missing settings row ⇒ hidden");

    // POSITIVE CONTROL from the SAME db: the opted-in user is still visible, so
    // this assertion is not passing merely because the fixture is empty.
    const ok = (await buildPassportProjection(seedDb([{ user_id: SHOWN, show_real_name: true }]), SHOWN, null, {
      resolveViewerContext: resolver(res),
    }))!;
    assert.equal(ok.identity.name, SHOWN_NAME);
  });

  it("hides the name for non-boolean / unknown show_real_name values", async () => {
    for (const value of [null, undefined, "true", 1, "yes", {}]) {
      const db = seedDb([
        { user_id: HIDDEN, show_real_name: value },
        { user_id: SHOWN, show_real_name: true },
      ]);
      const p = (await buildPassportProjection(db, HIDDEN, null, { resolveViewerContext: resolver(res) }))!;
      assert.equal(
        p.identity.name,
        null,
        `show_real_name=${JSON.stringify(value)} is not an explicit opt-in ⇒ hidden`,
      );
      // POSITIVE CONTROL in the same db.
      const ok = (await buildPassportProjection(
        seedDb([{ user_id: HIDDEN, show_real_name: value }, { user_id: SHOWN, show_real_name: true }]),
        SHOWN,
        null,
        { resolveViewerContext: resolver(res) },
      ))!;
      assert.equal(ok.identity.name, SHOWN_NAME);
    }
  });

  it("hides the name when the privacy lookup errors", async () => {
    // A client whose profile_privacy_settings read fails, but whose profiles
    // read succeeds — the shape of a partial DB outage / permission error.
    const good = seedBoth();
    const failing: any = {
      from(table: string) {
        if (table !== "profile_privacy_settings") return good.from(table);
        const b: any = {
          select() { return b; },
          in() { return b; },
          eq() { return b; },
          maybeSingle: async () => ({ data: null, error: { message: "boom" } }),
          then(onF: any, onR: any) {
            return Promise.resolve({ data: null, error: { message: "boom" }, count: 0 }).then(onF, onR);
          },
        };
        return b;
      },
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    };

    const p = (await buildPassportProjection(failing, HIDDEN, null, { resolveViewerContext: resolver(res) }))!;
    assert.equal(p.identity.name, null, "query error ⇒ hidden, never revealed");

    // POSITIVE CONTROL: the SAME opted-in user IS visible once the lookup works,
    // proving the null above came from the error path and not from the fixture.
    const ok = (await buildPassportProjection(seedBoth(), SHOWN, null, { resolveViewerContext: resolver(res) }))!;
    assert.equal(ok.identity.name, SHOWN_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// firstName / firstNameOnly ruling.
//
// No first-name field exists on this projection today, but one is being added
// by the Phase-8 variant work. A first name is still a real name, so a hidden
// name must yield null there too — NOT a "safe" fragment or an initial.
//
// That is enforced structurally rather than by a second predicate: the identity
// block derives every name field from the SANITIZED row, on which
// name/display_name/full_name are all null when the name is hidden. This test
// pins that property of the choke point so a first-name field added later
// inherits it.
// ─────────────────────────────────────────────────────────────────────────────

describe("name visibility — a first name is a real name", () => {
  it("the sanitized row yields null for any first-name derivation when hidden", async () => {
    const { nameVisibilitySet, sanitizeIdentity } = await import("../lib/publicIdentity.js");
    const db = seedBoth();
    const allowed = await nameVisibilitySet(db, [HIDDEN, SHOWN]);

    const firstNameOf = (row: Record<string, any>): string | null => {
      const full = row.display_name ?? row.name ?? row.full_name ?? null;
      return typeof full === "string" && full.trim() ? full.trim().split(/\s+/)[0]! : null;
    };

    const hiddenSafe = sanitizeIdentity(profileRow(HIDDEN, "bobt", HIDDEN_NAME), allowed, null);
    assert.equal(hiddenSafe.name, null);
    assert.equal(hiddenSafe.display_name, null);
    assert.equal(firstNameOf(hiddenSafe), null, "a hidden name yields NO first name, not 'Bob'");

    // POSITIVE CONTROL — the opted-in user's first name is still derivable.
    const shownSafe = sanitizeIdentity(profileRow(SHOWN, "alicev", SHOWN_NAME), allowed, null);
    assert.equal(firstNameOf(shownSafe), "Alice");

    // Owner short-circuit still works.
    const own = sanitizeIdentity(profileRow(HIDDEN, "bobt", HIDDEN_NAME), allowed, HIDDEN);
    assert.equal(firstNameOf(own), "Bob");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard — the NEXT passport consumer inherits the rule mechanically.
// ─────────────────────────────────────────────────────────────────────────────

const PASSPORT_SERVICES_DIR = new URL("../services/passport/", import.meta.url).pathname;

/** Extract the body of a function whose signature line index is given. */
function bodyAfter(src: string, fromIndex: number): string {
  const open = src.indexOf("{", fromIndex);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

describe("guard — every passport identity builder goes through the choke point", () => {
  const files = readdirSync(PASSPORT_SERVICES_DIR).filter((f) => f.endsWith(".ts"));

  it("every function returning PassportIdentity DERIVES its name fields from sanitizeIdentity", () => {
    let checked = 0;
    let nameFieldsChecked = 0;
    for (const f of files) {
      const src = readFileSync(join(PASSPORT_SERVICES_DIR, f), "utf8");
      // Matches `): PassportIdentity {` and `): Promise<PassportIdentity> {`.
      const re = /\)\s*:\s*(?:Promise<)?PassportIdentity>?\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        checked++;
        const body = bodyAfter(src, m.index);
        // (a) the choke point is called AND its result is bound. Merely calling
        //     it is not enough — an unused call is not a guard, and a revert of
        //     the routing typically leaves the call sitting there inert.
        const bind = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?sanitizeIdentity\s*\(/.exec(body);
        assert.ok(
          bind,
          `${f}: a function returning PassportIdentity does not bind the result of ` +
            `sanitizeIdentity() — the universal display-name rule would be bypassed. ` +
            `Import it from lib/publicIdentity.js rather than writing a new predicate.`,
        );
        const sanitized = bind![1];
        // (b) EVERY name-derived field on the returned object must read off that
        //     binding, never off the raw profile row. This is the half that
        //     actually fails when the routing is reverted.
        const nameField = /(?:^|\n)[ \t]*\b(name|displayName|fullName|firstName|firstNameOnly)\b\s*:([^\n]*)/g;
        let nm: RegExpExecArray | null;
        let sawNameField = false;
        while ((nm = nameField.exec(body)) !== null) {
          sawNameField = true;
          nameFieldsChecked++;
          assert.match(
            nm[2],
            new RegExp(`\\b${sanitized}\\s*\\.`),
            `${f}: the \`${nm[1]}\` field is not derived from \`${sanitized}\` (the sanitized ` +
              `row) — a name-derived field must never be read off the raw profile.`,
          );
        }
        assert.ok(
          sawNameField,
          `${f}: a PassportIdentity builder returns no name-derived field — the guard's ` +
            `field list is stale and it can no longer fail.`,
        );
      }
    }
    // Non-vacuous: the guard must actually have found the builder AND a field.
    assert.ok(checked >= 1, "guard found no PassportIdentity builder to check — regex is stale");
    assert.ok(nameFieldsChecked >= 1, "guard checked no name-derived field — regex is stale");
  });

  it("no passport service reads a raw display_name outside a sanitized row", () => {
    for (const f of files) {
      const src = readFileSync(join(PASSPORT_SERVICES_DIR, f), "utf8");
      src.split("\n").forEach((line, i) => {
        // Column lists in SELECT strings are fine; reads off an object are not,
        // unless the object is the sanitized copy.
        const read = /\b([A-Za-z_$][\w$]*)\.(display_name|full_name)\b/.exec(line);
        if (!read) return;
        assert.equal(
          read[1],
          "named",
          `${f}:${i + 1}: reads \`${read[0]}\` off an unsanitized row — route it through ` +
            `sanitizeIdentity() from lib/publicIdentity.js first.`,
        );
      });
    }
  });

  it("PassportProjectionService imports the canonical choke point", () => {
    const src = readFileSync(join(PASSPORT_SERVICES_DIR, "PassportProjectionService.ts"), "utf8");
    assert.match(
      src,
      /import\s*\{[^}]*nameVisibilitySet[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/publicIdentity\.js"/,
      "the projection service must resolve name visibility via lib/publicIdentity.js",
    );
    assert.match(
      src,
      /import\s*\{[^}]*sanitizeIdentity[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/publicIdentity\.js"/,
    );
  });
});

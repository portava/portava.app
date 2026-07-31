/**
 * portavaSeeder.test.ts
 *
 * Confirms that the @Portava seeder writes the correct avatar_url to the
 * profiles row — both when updating an existing profile (PATCH) and when
 * inserting a new one.
 *
 * Specifically guards against an accidental revert of PORTAVA_AVATAR_URL back
 * to a picsum.photos placeholder URL, which would go unnoticed until someone
 * manually inspects the profile header.
 *
 * Strategy: fake Supabase client injected via the optional `client` parameter
 * on upsertPortavaProfile. No live DB connections are made.
 *
 * Run: node --import tsx/esm --test src/test/portavaSeeder.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PORTAVA_AVATAR_URL,
  upsertPortavaProfile,
} from "../scripts/seed-portava-account.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_ID = "pv000000-0000-4000-a000-seeder000001";

/**
 * Build a minimal fake Supabase client that records what values were written
 * to the "profiles" table via .update() or .insert().
 *
 * The fake is structured to match the chained builder pattern the seeder uses:
 *   sc.from("profiles").select(...).eq(...).maybeSingle()   — returns `existing`
 *   sc.from("profiles").update({...}).eq(...)               — records payload
 *   sc.from("profiles").insert({...})                       — records payload
 */
function makeFakeClient(existingProfile: Record<string, any> | null): {
  client: any;
  written: { operation: "update" | "insert"; payload: Record<string, any> }[];
} {
  const written: { operation: "update" | "insert"; payload: Record<string, any> }[] = [];

  const client = {
    from(table: string) {
      if (table !== "profiles") {
        // Unexpected table — return a no-op builder.
        const noop: any = new Proxy(
          {},
          { get: () => (..._args: any[]) => noop },
        );
        return noop;
      }

      return {
        // SELECT path — called by the existence check
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: existingProfile, error: null });
                },
              };
            },
          };
        },

        // UPDATE path — called when the profile already exists
        update(payload: Record<string, any>) {
          written.push({ operation: "update", payload });
          return {
            eq(_col: string, _val: string) {
              return Promise.resolve({ error: null });
            },
          };
        },

        // INSERT path — called when no profile exists yet
        insert(payload: Record<string, any>) {
          written.push({ operation: "insert", payload });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  return { client, written };
}

// ── Constant integrity ────────────────────────────────────────────────────────

describe("PORTAVA_AVATAR_URL constant", () => {
  it("is not a picsum.photos placeholder URL", () => {
    assert.ok(
      !PORTAVA_AVATAR_URL.includes("picsum.photos"),
      `PORTAVA_AVATAR_URL must not be a picsum placeholder; got: ${PORTAVA_AVATAR_URL}`,
    );
  });

  it("is a non-empty HTTPS URL", () => {
    assert.ok(
      PORTAVA_AVATAR_URL.startsWith("https://"),
      `PORTAVA_AVATAR_URL must be an HTTPS URL; got: ${PORTAVA_AVATAR_URL}`,
    );
    assert.ok(PORTAVA_AVATAR_URL.length > 0, "PORTAVA_AVATAR_URL must not be empty");
  });
});

// ── PATCH path (existing profile) ─────────────────────────────────────────────

describe("upsertPortavaProfile — existing profile (PATCH)", () => {
  it("writes PORTAVA_AVATAR_URL via update() when a profile row already exists", async () => {
    const { client, written } = makeFakeClient({
      id: USER_ID,
      handle: "portava",
      is_official: false,
    });

    await upsertPortavaProfile(USER_ID, client);

    assert.equal(written.length, 1, "Expected exactly one write operation");
    const [op] = written;
    assert.equal(op.operation, "update", "Expected an UPDATE (not INSERT) for an existing profile");
    assert.equal(
      op.payload.avatar_url,
      PORTAVA_AVATAR_URL,
      `UPDATE payload avatar_url must equal PORTAVA_AVATAR_URL.\n` +
        `  Expected: ${PORTAVA_AVATAR_URL}\n` +
        `  Got:      ${op.payload.avatar_url}`,
    );
  });

  it("also sets is_official=true in the UPDATE payload", async () => {
    const { client, written } = makeFakeClient({
      id: USER_ID,
      handle: "portava",
      is_official: false,
    });

    await upsertPortavaProfile(USER_ID, client);

    assert.equal(written[0]?.payload?.is_official, true);
  });
});

// ── INSERT path (new profile) ─────────────────────────────────────────────────

describe("upsertPortavaProfile — new profile (INSERT)", () => {
  it("writes PORTAVA_AVATAR_URL via insert() when no profile row exists yet", async () => {
    const { client, written } = makeFakeClient(null);

    await upsertPortavaProfile(USER_ID, client);

    assert.equal(written.length, 1, "Expected exactly one write operation");
    const [op] = written;
    assert.equal(op.operation, "insert", "Expected an INSERT (not UPDATE) for a new profile");
    assert.equal(
      op.payload.avatar_url,
      PORTAVA_AVATAR_URL,
      `INSERT payload avatar_url must equal PORTAVA_AVATAR_URL.\n` +
        `  Expected: ${PORTAVA_AVATAR_URL}\n` +
        `  Got:      ${op.payload.avatar_url}`,
    );
  });

  it("also sets is_official=true in the INSERT payload", async () => {
    const { client, written } = makeFakeClient(null);

    await upsertPortavaProfile(USER_ID, client);

    assert.equal(written[0]?.payload?.is_official, true);
  });

  it("sets id to the provided userId in the INSERT payload", async () => {
    const { client, written } = makeFakeClient(null);

    await upsertPortavaProfile(USER_ID, client);

    assert.equal(written[0]?.payload?.id, USER_ID);
  });
});

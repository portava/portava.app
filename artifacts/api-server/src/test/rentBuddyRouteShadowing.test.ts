/**
 * Rent-a-Buddy route shadowing — no handler may be unreachable.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * routes/index.ts mounts four Rent-a-Buddy routers onto the same prefix, in a
 * fixed order (rentABuddy, rentABuddySpec, rentABuddyMarketplace,
 * rentABuddyRollout). Express serves the first layer whose path matches, so a
 * path declared by an earlier router silently swallows the same path in a later
 * one, and the later handler never runs. Nothing errors, nothing logs; the
 * endpoint simply does not exist while appearing to.
 *
 * Two instances existed on main and both were real:
 *
 *   1. `DELETE /rent-a-buddy/waitlist/:city` (rentABuddy) swallowed
 *      `DELETE /rent-a-buddy/waitlist/:waitlistId` (marketplace). The list
 *      endpoint hands clients `{ id, city }`, the client deleted by id, and the
 *      uuid was compared against the `city` column: 0 rows deleted, `{ok:true}`
 *      returned. That pair is legitimate — two different keys on one path — so
 *      it is resolved at runtime by shape (a uuid is handed on with next()) and
 *      is the one allowed exception below.
 *
 *   2. `GET /rent-a-buddy/bookings/:bookingId/events` was declared TWICE with
 *      the identical path, in rentABuddy and rentABuddySpec. The spec copy was
 *      dead, and it was the weaker of the two: `select("*")` with no admin_only
 *      filter, against an explicit column list with one. It has been deleted.
 *
 * This guard reads the routers as text so a NEW collision fails here rather
 * than in production, where the symptom is silence.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyRouteShadowing.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), "../routes");

/** Mount order, as declared in routes/index.ts. Earlier wins. */
const MOUNT_ORDER = [
  "rentABuddy.ts",
  "rentABuddySpec.ts",
  "rentABuddyMarketplace.ts",
  "rentABuddyRollout.ts",
] as const;

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

interface Decl { file: string; method: string; path: string }

function declarations(): Decl[] {
  const out: Decl[] = [];
  for (const file of MOUNT_ORDER) {
    const src = readFileSync(join(ROUTES, file), "utf8");
    for (const m of src.matchAll(ROUTE_RE)) {
      out.push({ file, method: m[1].toUpperCase(), path: m[2] });
    }
  }
  return out;
}

/** Path with every :param replaced by a positional placeholder. */
const shape = (p: string) => p.split("/").map((s) => (s.startsWith(":") ? ":_" : s)).join("/");

/**
 * The one collision that is intentional and resolved at runtime. rentABuddy's
 * :city handler hands a uuid-shaped parameter to the marketplace :waitlistId
 * handler with next() — proven in src/test/rentBuddyDeadSignals.test.ts.
 */
const ALLOWED_SHAPE_COLLISIONS = new Set(["DELETE /rent-a-buddy/waitlist/:_"]);

describe("Rent-a-Buddy routers declare no unreachable handler", () => {
  const decls = declarations();

  it("finds a plausible number of declarations, so the scan is not vacuous", () => {
    assert.ok(decls.length > 200, `only ${decls.length} route declarations parsed`);
    for (const f of MOUNT_ORDER) {
      assert.ok(decls.some((d) => d.file === f), `no routes parsed from ${f}`);
    }
  });

  it("no two routers declare the identical method and path", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const d of decls) {
      const key = `${d.method} ${d.path}`;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, d.file);
      else dupes.push(`${key} — declared in ${first} (wins) and again in ${d.file} (dead)`);
    }
    assert.deepEqual(dupes, [],
      "a later declaration of an already-mounted path can never run:\n" + dupes.join("\n"));
  });

  it("no parameterised segment shadows a differently-named one, except the resolved waitlist pair", () => {
    const byShape = new Map<string, Decl[]>();
    for (const d of decls) {
      const key = `${d.method} ${shape(d.path)}`;
      byShape.set(key, [...(byShape.get(key) ?? []), d]);
    }
    const offenders: string[] = [];
    for (const [key, group] of byShape) {
      if (group.length < 2) continue;
      // Same file: Express order within one router is the author's own choice
      // and is not cross-router shadowing.
      const files = new Set(group.map((g) => g.file));
      if (files.size < 2) continue;
      if (ALLOWED_SHAPE_COLLISIONS.has(key)) continue;
      offenders.push(`${key} — ${group.map((g) => `${g.file}:${g.path}`).join(" vs ")}`);
    }
    assert.deepEqual(offenders, [],
      "cross-router path-shape collision; the later router's handler is unreachable:\n" +
      offenders.join("\n"));
  });

  it("the allowed waitlist collision still exists — the exemption is not stale", () => {
    const group = decls.filter((d) => `${d.method} ${shape(d.path)}` === "DELETE /rent-a-buddy/waitlist/:_");
    assert.equal(group.length, 2,
      "the exempted waitlist pair is gone; remove it from ALLOWED_SHAPE_COLLISIONS " +
      "rather than leaving a dead exemption that could mask a future collision");
  });
});
